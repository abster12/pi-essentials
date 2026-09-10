import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHerdrSplitArgs,
  buildTmuxListPanesArgs,
  buildTmuxSplitArgs,
  buildTmuxWindowQueryArgs,
  buildHerdrProcessInfoArgs,
  buildTmuxIdleQueryArgs,
  findDedupPanes,
  parseDirection,
  parseHerdrPaneList,
  parseHerdrProcessIdle,
  parseSplitPaneId,
  parseTmuxIdle,
  parseTmuxPaneList,
  parseWindowId,
  pickReuseTarget,
  resolveMux,
  sanitizePaneName,
  validateSplitParams,
  PANE_NAME_MAX,
} from "../split-pane.ts";

/** Tests for the pure helpers that power the split_pane extension's split +
 *  rename wiring. These are real production logic (the argv arrays are handed
 *  verbatim to execFileSync + the tmux/herdr CLIs), so a wrong flag means a
 *  broken pane or a hung tool in the user's terminal. */

describe("resolveMux", () => {
  // Backend detection is env-only: herdr wins when HERDR_ENV=1 +
  // HERDR_PANE_ID are set, tmux is the fallback, neither means "no side panes
  // available". We assert both the kind AND the parentPane it carries, because
  // execute uses backend.parentPane directly (no env re-reads, no `!`).
  it("prefers herdr when HERDR_ENV=1 + HERDR_PANE_ID are set", () => {
    const mux = resolveMux({ HERDR_ENV: "1", HERDR_PANE_ID: "w3:p1" });
    assert.equal(mux?.kind, "herdr");
    assert.equal(mux?.parentPane, "w3:p1");
  });
  it("uses tmux when inside tmux but not herdr", () => {
    const mux = resolveMux({ TMUX: "1", TMUX_PANE: "%5" });
    assert.equal(mux?.kind, "tmux");
    assert.equal(mux?.parentPane, "%5");
  });
  it("returns undefined with neither multiplexer", () => {
    assert.equal(resolveMux({}), undefined);
  });
  // Negative cases: a lone pane-id var must not fake "inside herdr/tmux".
  it("does NOT pick herdr without ENV=1 even if a pane id is present", () => {
    assert.equal(resolveMux({ HERDR_PANE_ID: "w3:p1" }), undefined);
  });
  it("does NOT pick tmux with only TMUX_PANE (no TMUX)", () => {
    assert.equal(resolveMux({ TMUX_PANE: "%5" }), undefined);
  });
  it("prefers herdr over tmux when both are present", () => {
    const mux = resolveMux({
      HERDR_ENV: "1", HERDR_PANE_ID: "w3:p1", TMUX: "1", TMUX_PANE: "%5",
    });
    assert.equal(mux?.kind, "herdr");
    assert.equal(mux?.parentPane, "w3:p1");
  });
});

// sanitizePaneName: free-text names become pane labels — trim, collapse
// internal whitespace, clamp to the cap. Labels keep spaces/case (unlike
// slug-restricted herdr agent names), so no lowercasing or slugging here.
describe("sanitizePaneName", () => {
  it("trims and collapses internal whitespace", () => {
    assert.equal(sanitizePaneName("  dev    server "), "dev server");
  });
  it("returns short names unchanged", () => {
    assert.equal(sanitizePaneName("storybook"), "storybook");
  });
  // Slicing can leave a trailing space, so the clamp re-trims — assert both
  // the cap and the lack of a dangling space.
  it("clamps to the max length without a trailing space", () => {
    const long = "x".repeat(PANE_NAME_MAX + 25);
    const out = sanitizePaneName(long);
    assert.ok(out.length <= PANE_NAME_MAX, "exceeded cap");
    assert.ok(!out.endsWith(" "), "trailing space");
  });
  it("preserves case and spaces (pane labels aren't slug-restricted)", () => {
    assert.equal(sanitizePaneName("My Dev Server"), "My Dev Server");
  });
  it("clamps at a custom max", () => {
    assert.equal(sanitizePaneName("abcdefgh", 4), "abcd");
  });
});

// validateSplitParams: execute's first gate — command/name must be non-empty
// after trimming, so we never split a pane for a garbage invocation.
describe("validateSplitParams", () => {
  it("trims command and name", () => {
    assert.deepEqual(
      validateSplitParams({ command: "  python -m http.server 8000  ", name: "  http  " }),
      { command: "python -m http.server 8000", name: "http" },
    );
  });
  it("throws on an empty command", () => {
    assert.throws(() => validateSplitParams({ command: "   ", name: "http" }), /non-empty `command`/);
  });
  it("throws on an empty name", () => {
    assert.throws(() => validateSplitParams({ command: "cargo run", name: "" }), /non-empty `name`/);
  });
});

// parseDirection: direction is a strict union. Missing → "right" default;
// anything else throws instead of silently coercing (the TypeBox schema also
// rejects bad values before execute; this guards direct callers and tests).
describe("parseDirection", () => {
  it("defaults to 'right' when unspecified", () => {
    assert.equal(parseDirection(undefined), "right");
  });
  it("accepts 'right' and 'down'", () => {
    assert.equal(parseDirection("right"), "right");
    assert.equal(parseDirection("down"), "down");
  });
  it("rejects anything else instead of coercing", () => {
    assert.throws(() => parseDirection("left"), /invalid direction/);
    assert.throws(() => parseDirection("up"), /invalid direction/);
    assert.throws(() => parseDirection(""), /invalid direction/);
  });
});

// buildHerdrSplitArgs: the exact argv handed to `herdr pane split`. Direction
// maps to --direction, --no-focus keeps the agent pane focused.
describe("buildHerdrSplitArgs", () => {
  it("defaults to a right (vertical) split, no-focus, same cwd", () => {
    assert.deepEqual(
      buildHerdrSplitArgs({ parentPane: "w3:p1", cwd: "/repo" }),
      ["pane", "split", "--pane", "w3:p1", "--direction", "right", "--cwd", "/repo", "--no-focus"],
    );
  });
  it("honours an explicit 'down' direction", () => {
    const args = buildHerdrSplitArgs({ parentPane: "w3:p1", cwd: "/repo", direction: "down" });
    assert.equal(args[args.indexOf("--direction") + 1], "down");
  });
});

// parseSplitPaneId: `herdr pane split` prints JSON on stdout; the new pane id
// is a narrow typed pick of result.pane.pane_id. If parsing is wrong the whole
// tool breaks, so malformed output must throw loudly, not misbehave silently.
describe("parseSplitPaneId", () => {
  it("extracts the pane id from herdr pane split JSON", () => {
    const raw = JSON.stringify({ id: "cli:pane:split", result: { pane: { pane_id: "w3:p2" } } });
    assert.equal(parseSplitPaneId(raw), "w3:p2");
  });
  it("throws when the JSON has no pane_id", () => {
    assert.throws(() => parseSplitPaneId('{"result":{"pane":{}}}'), /no pane_id/);
  });
  it("throws when pane_id is not a string", () => {
    assert.throws(() => parseSplitPaneId('{"result":{"pane":{"pane_id":42}}}'), /no pane_id/);
  });
  it("throws on non-JSON output", () => {
    assert.throws(() => parseSplitPaneId("not json"), /non-JSON/);
  });
});

// parseHerdrPaneList: `herdr pane list` JSON → the PaneInfo[] the dedup check
// consumes. Agent panes are flagged (they're pi sessions, never command panes).
// Malformed output throws — callers (backend.find) treat any throw as
// "no dedup info" and split anyway, so this must not silently misparse.
describe("parseHerdrPaneList", () => {
  it("extracts pane id, label, tab id and agent-ness", () => {
    const raw = JSON.stringify({
      id: "cli:pane:list",
      result: {
        panes: [
          { pane_id: "w1:pC", label: "expo", tab_id: "w1:t4" },
          { pane_id: "w1:p5", label: "start-mobile-expo-server", tab_id: "w1:t4", agent: "pi" },
          { pane_id: "w3:p1", label: "watcher" },
        ],
        type: "pane_list",
      },
    });
    const panes = parseHerdrPaneList(raw);
    assert.equal(panes.length, 3);
    assert.deepEqual(panes[0], { paneId: "w1:pC", label: "expo", tabId: "w1:t4", isAgent: false });
    assert.equal(panes[1].isAgent, true);
    assert.equal(panes[2].tabId, undefined);
  });
  it("throws on non-JSON output", () => {
    assert.throws(() => parseHerdrPaneList("not json"), /non-JSON/);
  });
  it("throws when the panes array is missing", () => {
    assert.throws(() => parseHerdrPaneList('{"result":{}}'), /no panes array/);
  });
});

// findDedupPanes: same label in the parent's own tab → reuse candidates;
// anything else (other tab, agent pane, the parent itself, no known parent
// tab) → [], i.e. split a fresh pane.
describe("findDedupPanes", () => {
  const panes = [
    { paneId: "w1:pC", label: "expo", tabId: "w1:t4", isAgent: false },
    { paneId: "w1:pH", label: "expo", tabId: "w1:t4", isAgent: false },
    { paneId: "w1:pD", label: "expo", tabId: "w1:t5", isAgent: false },
    { paneId: "w1:pE", label: "expo", tabId: "w1:t4", isAgent: true },
    { paneId: "w1:pF", label: "api", tabId: "w1:t4", isAgent: false },
    { paneId: "w1:pG", label: "watcher", tabId: "w1:t4", isAgent: false },
  ];
  it("matches the same label in the same tab (all of them)", () => {
    assert.deepEqual(
      findDedupPanes(panes, "w1:p1", "w1:t4", "expo").map((p) => p.paneId),
      ["w1:pC", "w1:pH"],
    );
  });
  it("ignores same-label panes in other tabs", () => {
    assert.deepEqual(
      findDedupPanes(panes, "w1:p1", "w1:t5", "expo").map((p) => p.paneId),
      ["w1:pD"],
    );
  });
  it("never matches an agent (pi session) pane", () => {
    const onlyAgent = [
      { paneId: "w1:pE", label: "expo", tabId: "w1:t4", isAgent: true },
    ];
    assert.deepEqual(findDedupPanes(onlyAgent, "w1:p1", "w1:t4", "expo"), []);
  });
  it("never matches the parent pane itself", () => {
    assert.deepEqual(findDedupPanes(panes, "w1:pG", "w1:t4", "watcher"), []);
  });
  it("returns [] when the parent tab is unknown (don't guess)", () => {
    assert.deepEqual(findDedupPanes(panes, "w1:p1", undefined, "expo"), []);
  });
  it("returns [] when nothing matches", () => {
    assert.deepEqual(findDedupPanes(panes, "w1:p1", "w1:t4", "storybook"), []);
  });
  it("matches labels exactly (case-sensitive, no prefix guessing)", () => {
    assert.equal(findDedupPanes(panes, "w1:p1", "w1:t4", "expo")[0]?.paneId, "w1:pC");
    assert.deepEqual(findDedupPanes(panes, "w1:p1", "w1:t4", "Exp"), []);
    assert.deepEqual(findDedupPanes(panes, "w1:p1", "w1:t4", "exp"), []);
  });
});

// pickReuseTarget: busy same-named pane wins (leave it); else run in the first.
describe("pickReuseTarget", () => {
  const a = { paneId: "w1:pC", label: "expo", tabId: "w1:t4", isAgent: false };
  const b = { paneId: "w1:pH", label: "expo", tabId: "w1:t4", isAgent: false };
  const idle = new Map<string, boolean | undefined>([
    ["w1:pC", true],
    ["w1:pH", true],
  ]);
  const idleOf = (id: string) => idle.get(id);
  it("returns undefined when there are no candidates", () => {
    assert.equal(pickReuseTarget([], idleOf), undefined);
  });
  it("runs in the first pane when all are idle or unknown", () => {
    assert.deepEqual(pickReuseTarget([a, b], idleOf), { pane: a, run: true });
    idle.set("w1:pC", undefined);
    assert.deepEqual(pickReuseTarget([a, b], idleOf), { pane: a, run: true });
  });
  it("leaves a busy pane even if an earlier one is idle", () => {
    idle.set("w1:pC", true);
    idle.set("w1:pH", false);
    assert.deepEqual(pickReuseTarget([a, b], idleOf), { pane: b, run: false });
  });
});

describe("parseHerdrProcessIdle", () => {
  it("is idle when the foreground pgid is the shell", () => {
    const raw = JSON.stringify({
      result: { process_info: { shell_pid: 72386, foreground_process_group_id: 72386 } },
    });
    assert.equal(parseHerdrProcessIdle(raw), true);
  });
  it("is busy when a job owns the foreground pgid", () => {
    const raw = JSON.stringify({
      result: { process_info: { shell_pid: 31622, foreground_process_group_id: 31659 } },
    });
    assert.equal(parseHerdrProcessIdle(raw), false);
  });
  it("throws on non-JSON or missing ids", () => {
    assert.throws(() => parseHerdrProcessIdle("not json"), /non-JSON/);
    assert.throws(() => parseHerdrProcessIdle("{}"), /no process ids/);
  });
});

describe("parseTmuxIdle", () => {
  it("treats shells (and login -zsh) as idle", () => {
    assert.equal(parseTmuxIdle("zsh\n"), true);
    assert.equal(parseTmuxIdle("-zsh"), true);
    assert.equal(parseTmuxIdle("bash"), true);
  });
  it("treats a real command as busy", () => {
    assert.equal(parseTmuxIdle("node"), false);
    assert.equal(parseTmuxIdle("npm"), false);
  });
  it("throws on empty output", () => {
    assert.throws(() => parseTmuxIdle("  \n"), /no current command/);
  });
});

describe("buildHerdrProcessInfoArgs", () => {
  it("asks process-info for a pane", () => {
    assert.deepEqual(buildHerdrProcessInfoArgs("w1:pC"), ["pane", "process-info", "--pane", "w1:pC"]);
  });
});

describe("buildTmuxIdleQueryArgs", () => {
  it("asks display-message for the pane's current command", () => {
    assert.deepEqual(buildTmuxIdleQueryArgs("%5"), [
      "display-message", "-p", "-t", "%5", "#{pane_current_command}",
    ]);
  });
});

// tmux dedup plumbing: window query, pane listing, and line parsing. The
// window id is tmux's "tab", so list results are tagged with it for the
// same-tab scoping findDedupPanes enforces.
describe("buildTmuxWindowQueryArgs", () => {
  it("asks display-message for the parent's window id", () => {
    assert.deepEqual(buildTmuxWindowQueryArgs("%5"), ["display-message", "-p", "-t", "%5", "#{window_id}"]);
  });
});

describe("parseWindowId", () => {
  it("trims the window id", () => {
    assert.equal(parseWindowId("@1\n"), "@1");
  });
  it("throws when the output is empty", () => {
    assert.throws(() => parseWindowId("  \n"), /no window id/);
  });
});

describe("buildTmuxListPanesArgs", () => {
  it("lists panes of a window with pane id + title", () => {
    assert.deepEqual(buildTmuxListPanesArgs("@1"), [
      "list-panes", "-t", "@1", "-F", "#{pane_id}\t#{pane_title}",
    ]);
  });
});

describe("parseTmuxPaneList", () => {
  it("parses id/title lines and tags the window id as the tab", () => {
    const raw = "%1\tapi\n%2\t\n%3\tstorybook";
    assert.deepEqual(parseTmuxPaneList(raw, "@1"), [
      { paneId: "%1", label: "api", tabId: "@1", isAgent: false },
      { paneId: "%2", label: "", tabId: "@1", isAgent: false },
      { paneId: "%3", label: "storybook", tabId: "@1", isAgent: false },
    ]);
  });
  it("skips blank lines and lines without a separator", () => {
    const panes = parseTmuxPaneList("\n%1\tapi\nno-tab-line\n", "@1");
    assert.equal(panes.length, 1);
    assert.equal(panes[0].paneId, "%1");
  });
});

// buildTmuxSplitArgs: the exact argv handed to `tmux split-window`. -h/-v is
// the tmux side of the direction union (right/down), -d keeps focus on the
// agent pane, -P -F prints the new pane id for us to parse.
describe("buildTmuxSplitArgs", () => {
  it("produces a side-by-side split off the parent that keeps focus and prints the id", () => {
    const args = buildTmuxSplitArgs({ parentPane: "%3", cwd: "/repo" });
    assert.ok(args.includes("-h"), "side-by-side (-h)");
    assert.ok(args.includes("-d"), "do not steal focus (-d)");
    assert.ok(args.includes("split-window"), "is a split-window invocation");
    assert.equal(args[args.indexOf("-c") + 1], "/repo");
    assert.equal(args[args.indexOf("-t") + 1], "%3");
    assert.equal(args[args.indexOf("-F") + 1], "#{pane_id}");
  });
  it("defaults to a horizontal (right) split, also for an explicit 'right'", () => {
    assert.ok(buildTmuxSplitArgs({ parentPane: "%3", cwd: "/repo" }).includes("-h"));
    assert.ok(
      buildTmuxSplitArgs({ parentPane: "%3", cwd: "/repo", direction: "right" }).includes("-h"),
    );
  });
  // 'down' must flip to -v AND drop -h — a stale -h would silently split
  // side-by-side despite the user asking for stacked.
  it("splits stacked below for direction 'down'", () => {
    const args = buildTmuxSplitArgs({ parentPane: "%3", cwd: "/repo", direction: "down" });
    assert.ok(args.includes("-v"), "stacked (-v)");
    assert.ok(!args.includes("-h"), "no -h when down");
  });
});
