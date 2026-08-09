/**
 * split_pane — run any long-running local process in a side pane.
 *
 * When the user asks to start a dev server, watcher, notebook, compiler, or
 * any other long-running local process, this tool splits a new pane beside
 * the agent — in the same herdr tab / same tmux window — names that pane
 * after the process, and runs the launch command in its interactive shell.
 * Logs stream there, Ctrl-C in that pane stops it, and the agent pane keeps
 * focus (the split itself is non-focus-stealing; the user switches panes
 * manually — no focus hints by design).
 *
 * Backends, mirroring auto-title / subagent:
 *   - herdr (preferred): `herdr pane split --direction right --no-focus` then
 *     `herdr pane rename` + `herdr pane send-text` + `herdr pane send-keys Enter`.
 *   - tmux (fallback):   `tmux split-window -h -d` (= side-by-side, same tab)
 *     then `select-pane -T` + `send-keys ... Enter`.
 *   - neither:           throws a clear error — this tool needs a multiplexer
 *     so the process lands in a *visible* pane you can watch, not a
 *     background process you lose track of.
 *
 * Why send-text + send-keys Enter instead of the fire-and-forget `herdr pane run`:
 * `pane run` takes the command as argv tokens and (in its short form) does not
 * guarantee a shell, so `PORT=8000 ./gradlew bootRun && tail -f build.log` or
 * pipes would break. send-text + Enter feeds the literal string to the new
 * pane's interactive shell, which parses it with full shell semantics — the
 * same pattern subagent's tmux path already relies on. tty input is buffered,
 * so type-ahead survives the brief moment before the shell prints its prompt.
 *
 * Dedup — the model's context is lossy (pruning, new sessions, closed panes),
 * so it cannot be trusted to remember which panes exist: the tool itself
 * queries the mux before splitting. If a non-agent pane in the parent's tab
 * already carries the requested `name`, split_pane reuses it (returns a pointer
 * + hint) instead of splitting a duplicate. `force: true` bypasses the check
 * for legit second instances (e.g. two servers on different ports). Dedup is
 * best-effort: a failed `pane list` never fails the tool — it just splits.
 *
 * "A process should keep running" is the model's job, not an event: the
 * tool's description + promptGuidelines tell it to use `split_pane` for any
 * long-running local process and never `&`/nohup one itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";

/** Side-by-side split ("right") or stacked ("down"). Default right. */
export type SplitDirection = "right" | "down";

/** Mux backends supported by the mux adapter below. */
export type MuxBackendKind = "herdr" | "tmux";

/**
 * One mux-driven interface for "split → rename → run → stop hint", so the
 * tool body never branches per backend. Each backend owns its own CLI calls,
 * split-output parsing, and error wrapping ("X pane split failed: …").
 * No focusHint by design — see "Focus behavior" in the header.
 */
export type MuxBackend = {
  kind: MuxBackendKind;
  parentPane: string;
  /** Split a new pane off the parent. Returns the new pane id. */
  split(opts: { cwd: string; direction: SplitDirection }): string;
  /** Name the pane (cosmetic — soft-fail). */
  rename(paneId: string, label: string): void;
  /** Run the command in the new pane's interactive shell. Throws → leave the pane open. */
  run(paneId: string, command: string): void;
  /** Best-effort dedup: find an existing non-agent pane in the parent's tab
   *  with the same label. Never throws — undefined means "split anew". */
  find(label: string): PaneInfo | undefined;
  /** Human hint for how to stop the process (used in the tool reply). */
  stopHint(paneId: string): string;
};

/** Sensible cap on a pane label. herdr pane labels accept spaces/case (unlike
 *  herdr *agent* names, which are slug-restricted); we just trim + clamp. */
export const PANE_NAME_MAX = 80;

/** Detect the active multiplexer and construct its backend, or undefined.
 *  Env-only (no IO at construction) so it can be reasoned about and tested. */
export function resolveMux(env: NodeJS.ProcessEnv = process.env): MuxBackend | undefined {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return herdrBackend(env.HERDR_PANE_ID);
  if (env.TMUX && env.TMUX_PANE) return tmuxBackend(env.TMUX_PANE);
  return undefined;
}

/** Clean a free-text name into a pane label: trim, collapse whitespace, clamp. */
export function sanitizePaneName(name: string, max = PANE_NAME_MAX): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+$/, "");
}

/** Trim + require the command/name params; returns the cleaned pair. */
export function validateSplitParams(params: {
  command?: string;
  name?: string;
}): { command: string; name: string } {
  const command = params.command?.trim();
  if (!command) throw new Error("split_pane requires a non-empty `command`.");
  const name = params.name?.trim();
  if (!name) throw new Error("split_pane requires a non-empty `name`.");
  return { command, name };
}

/** Resolve the optional direction param; unknown values throw instead of
 *  silently coercing to the default. (The schema already restricts callers;
 *  this is the belt-and-braces rejection for direct callers/tests.) */
export function parseDirection(raw: string | undefined): SplitDirection {
  if (raw === undefined || raw === "right") return "right";
  if (raw === "down") return "down";
  throw new Error(`split_pane: invalid direction "${raw}" — expected "right" or "down".`);
}

/** argv for `herdr pane split` (without the leading "herdr" command). Pure so
 *  the wiring is unit-testable without a live exec/herdr socket. */
export function buildHerdrSplitArgs(opts: {
  parentPane: string;
  cwd: string;
  direction?: SplitDirection;
}): string[] {
  return [
    "pane", "split",
    "--pane", opts.parentPane,
    "--direction", opts.direction ?? "right",
    "--cwd", opts.cwd,
    "--no-focus",
  ];
}

/** Narrow shape of `herdr pane split` JSON stdout. */
type HerdrSplitOutput = {
  result?: { pane?: { pane_id?: unknown } };
};

/** Parse the JSON stdout of `herdr pane split` into the new pane id, or throw. */
export function parseSplitPaneId(raw: string): string {
  let parsed: HerdrSplitOutput;
  try {
    parsed = JSON.parse(raw) as HerdrSplitOutput;
  } catch {
    throw new Error(`herdr pane split returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  const id = parsed?.result?.pane?.pane_id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("herdr pane split returned no pane_id");
  }
  return id;
}

/** argv for `tmux split-window` that splits off the parent, keeps focus on the
 *  parent (-d), and prints the new pane id (-P -F). `right` → -h (side-by-side),
 *  `down` → -v (stacked). */
export function buildTmuxSplitArgs(opts: {
  parentPane: string;
  cwd: string;
  direction?: SplitDirection;
}): string[] {
  return [
    "split-window",
    opts.direction === "down" ? "-v" : "-h",
    "-d",
    "-c", opts.cwd,
    "-t", opts.parentPane,
    "-P", "-F", "#{pane_id}",
  ];
}

/** A pane as reported by `herdr pane list` / `tmux list-panes`, in the shape
 *  the dedup check needs. tabId is the herdr tab id (for tmux: the window id —
 *  window == tab in tmux terms). isAgent marks pi agent panes, which are never
 *  command panes and must not be "reused" for a split. */
export type PaneInfo = {
  paneId: string;
  label: string;
  tabId?: string;
  isAgent: boolean;
};

/** Parse `herdr pane list` JSON (result.panes[]) into PaneInfo[], or throw. */
export function parseHerdrPaneList(raw: string): PaneInfo[] {
  let parsed: { result?: { panes?: unknown } };
  try {
    parsed = JSON.parse(raw) as { result?: { panes?: unknown } };
  } catch {
    throw new Error(`herdr pane list returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  const panes = parsed?.result?.panes;
  if (!Array.isArray(panes)) throw new Error("herdr pane list returned no panes array");
  return panes.map((p) => {
    const pane = (p ?? {}) as Record<string, unknown>;
    return {
      paneId: typeof pane.pane_id === "string" ? pane.pane_id : "",
      label: typeof pane.label === "string" ? pane.label : "",
      tabId: typeof pane.tab_id === "string" ? pane.tab_id : undefined,
      isAgent: pane.agent !== undefined,
    };
  });
}

/** argv for `tmux display-message` that prints the parent's window id. */
export function buildTmuxWindowQueryArgs(parentPane: string): string[] {
  return ["display-message", "-p", "-t", parentPane, "#{window_id}"];
}

/** Trim the window id from display-message stdout, or throw when empty. */
export function parseWindowId(raw: string): string {
  const id = raw.trim();
  if (!id) throw new Error("tmux display-message printed no window id");
  return id;
}

/** argv for `tmux list-panes` printing pane id + title (what select-pane -T
 *  set, i.e. our pane label). */
export function buildTmuxListPanesArgs(windowId: string): string[] {
  return ["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_title}"];
}

/** Parse `tmux list-panes -F '#{pane_id}\t#{pane_title}'` lines into PaneInfo.
 *  The window id is the tmux "tab", so it becomes each pane's tabId. */
export function parseTmuxPaneList(raw: string, windowId: string): PaneInfo[] {
  const panes: PaneInfo[] = [];
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue; // blank line, or a line with no id/title separator
    panes.push({
      paneId: line.slice(0, tab),
      label: line.slice(tab + 1),
      tabId: windowId,
      isAgent: false,
    });
  }
  return panes;
}

/** The dedup core: would `label` already be "running" as a command pane?
 *  Matches only non-agent panes in the parent's own tab; the parent pane
 *  itself never counts; an unknown parent tab means "don't guess" → no match. */
export function findDedupPane(
  panes: PaneInfo[],
  parentPaneId: string,
  parentTabId: string | undefined,
  label: string,
): PaneInfo | undefined {
  if (!parentTabId) return undefined;
  return panes.find(
    (p) => p.paneId !== parentPaneId && !p.isAgent && p.tabId === parentTabId && p.label === label,
  );
}

function herdrBackend(parentPane: string): MuxBackend {
  return {
    kind: "herdr",
    parentPane,
    split({ cwd, direction }) {
      try {
        const raw = execFileSync(
          "herdr", buildHerdrSplitArgs({ parentPane, cwd, direction }), { encoding: "utf8" },
        );
        return parseSplitPaneId(raw);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`herdr pane split failed: ${msg}`);
      }
    },
    rename(paneId, label) {
      // Cosmetic — a failed rename must not fail the tool.
      try { execFileSync("herdr", ["pane", "rename", paneId, label], { stdio: "ignore" }); }
      catch { /* cosmetic */ }
    },
    run(paneId, command) {
      // send-text + Enter so full shell syntax (env vars, &&, pipes) is
      // parsed by the new pane's shell, not by herdr argv handling.
      execFileSync("herdr", ["pane", "send-text", paneId, command], { stdio: "ignore" });
      execFileSync("herdr", ["pane", "send-keys", paneId, "Enter"], { stdio: "ignore" });
    },
    find(label) {
      // Best-effort dedup: a failed list must never fail the tool.
      try {
        const raw = execFileSync("herdr", ["pane", "list"], { encoding: "utf8" });
        const panes = parseHerdrPaneList(raw);
        const parent = panes.find((p) => p.paneId === parentPane);
        return findDedupPane(panes, parentPane, parent?.tabId, label);
      } catch {
        return undefined;
      }
    },
    stopHint(paneId) {
      return `\`herdr pane send-keys ${paneId} C-c\` (or Ctrl-C in that pane)`;
    },
  };
}

function tmuxBackend(parentPane: string): MuxBackend {
  return {
    kind: "tmux",
    parentPane,
    split({ cwd, direction }) {
      try {
        const raw = execFileSync(
          "tmux", buildTmuxSplitArgs({ parentPane, cwd, direction }), { encoding: "utf8" },
        );
        const paneId = raw.trim().split(/\s+/)[0];
        if (!paneId) throw new Error("tmux split-window printed no pane id");
        return paneId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`tmux split-window failed: ${msg}`);
      }
    },
    rename(paneId, label) {
      // Cosmetic pane-border title — soft-fail like herdr's rename.
      try { execFileSync("tmux", ["select-pane", "-t", paneId, "-T", label], { stdio: "ignore" }); }
      catch { /* cosmetic */ }
    },
    run(paneId, command) {
      execFileSync("tmux", ["send-keys", "-t", paneId, command, "Enter"], { stdio: "ignore" });
    },
    find(label) {
      // Best-effort dedup: window == tab in tmux; pane_title is what our
      // select-pane -T rename set. A failed query never fails the tool.
      try {
        const winRaw = execFileSync("tmux", buildTmuxWindowQueryArgs(parentPane), { encoding: "utf8" });
        const windowId = parseWindowId(winRaw);
        const raw = execFileSync("tmux", buildTmuxListPanesArgs(windowId), { encoding: "utf8" });
        return findDedupPane(parseTmuxPaneList(raw, windowId), parentPane, windowId, label);
      } catch {
        return undefined;
      }
    },
    stopHint(paneId) {
      return `\`tmux send-keys -t ${paneId} C-c\` (or Ctrl-C in that pane)`;
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "split_pane",
    label: "Run in side pane",
    description:
      "Run a long-running local process (dev server, watcher, notebook, compiler, etc.) in its OWN side pane beside the agent, instead of backgrounding it in bash. " +
      "Splits a new pane in the same herdr tab / same tmux window, names it after the process, and runs the command in that pane's interactive shell. " +
      "If a pane with the same `name` already exists in the current tab, it reuses that pane instead of splitting a duplicate (pass `force: true` to split anyway). " +
      "Logs stream there; Ctrl-C in that pane stops it. " +
      "Use this instead of `&`, `nohup`, or `disown` for any process that stays alive.",
    promptSnippet: "Run a long-running local process in a side pane — never background it in bash",
    promptGuidelines: [
      "Use split_pane for ANY long-running local process: `./gradlew bootRun`, `./mvnw spring-boot:run`, `flutter run`, `cargo run`, `go run .`, `docker compose up`, `uv run uvicorn app:app`, `python manage.py runserver`, `python -m http.server`, `npm run dev`, `storybook`, notebook servers, watch tasks, etc.",
      "Never background a long-running process yourself with `&`, `nohup`, or `disown` — always call split_pane so it lands in a named, watchable side pane.",
      "Give it a short human-readable `name` so the user can tell panes apart (e.g. 'api', 'storybook', 'watcher').",
      "split_pane dedups by pane `name`: if a pane with the same `name` already exists in the current tab, it reuses that pane instead of splitting a duplicate. Give the same process the same `name` every time (e.g. always 'api' for the API server) — asking to start it again then points at the running pane instead of spawning a duplicate. Pass `force: true` only when you genuinely want a second instance.",
      "Before splitting you can check what's already running with `herdr pane list` (or `tmux list-panes`) — though split_pane's own dedup usually makes that unnecessary.",
      "For quick one-shot commands (tests, lint, `ls`) use the bash tool normally — split_pane is for processes that stay running.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "The exact shell command to run, e.g. `./gradlew bootRun` or `python -m http.server 8000`. May include env vars, pipes, && — it runs in an interactive shell in the new pane.",
      }),
      name: Type.String({
        description: "Short human-readable label for the pane, e.g. 'api', 'storybook', 'watcher'. The user sees this in the tab strip / pane border.",
      }),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the new pane (default: current directory)." }),
      ),
      direction: Type.Optional(
        Type.Union([Type.Literal("right"), Type.Literal("down")], {
          description: "Split direction: 'right' (side-by-side, default) or 'down' (stacked).",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Split a new pane even if a pane with the same `name` already exists in the current tab (default: reuse the existing pane).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { command, name } = validateSplitParams(params);
      const label = sanitizePaneName(name);
      const cwd = params.cwd?.trim() || ctx.cwd;
      const direction = parseDirection(params.direction);

      const backend = resolveMux();
      if (!backend) {
        throw new Error(
          "split_pane needs pi running inside herdr or tmux so the process can land in a visible side pane. " +
          "Run pi inside herdr (recommended) or attach a tmux session, then retry.",
        );
      }

      // Dedup: the model's context can't be trusted to remember which panes
      // exist (prunes, new sessions, panes the user closed), so the tool
      // checks the mux itself before splitting a duplicate.
      if (params.force !== true) {
        const existing = backend.find(label);
        if (existing) {
          return {
            content: [{
              type: "text",
              text:
                `Pane ${existing.paneId} ("${label}") already exists in this tab — reusing it instead of splitting a duplicate. ` +
                `If its process is still running, you're set (logs stream in that pane). ` +
                `If it died, Ctrl-C in that pane and re-run \`${command}\` there, ` +
                `or call split_pane with force: true for a fresh pane.`,
            }],
            details: {
              paneId: existing.paneId, backend: backend.kind, label, command, cwd, reused: true,
            },
          };
        }
      }

      const paneId = backend.split({ cwd, direction });
      backend.rename(paneId, label);
      try {
        backend.run(paneId, command);
      } catch (e: unknown) {
        // Leave the pane open (named) so the user can start the command by hand
        // if our key injection failed — better to leak a named pane than hide it.
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `split_pane: opened pane ${paneId} (${label}) but failed to start the command: ${msg}. ` +
          `Run \`${command}\` manually in that pane.`,
        );
      }

      return {
        content: [{
          type: "text",
          text:
            `Started \`${command}\` in a new side pane ${paneId} (${backend.kind}, label "${label}"). ` +
            `Logs stream there beside the agent. ` +
            `Stop it: ${backend.stopHint(paneId)}.`,
        }],
        details: { paneId, backend: backend.kind, label, command, cwd },
      };
    },
  });
}
