/**
 * Auto Title Extension
 *
 * Names the host terminal tab from the first user input of an unnamed
 * session. Two backends:
 *   - herdr (preferred): `herdr pane rename <pane> <label>` — the tab you
 *     open inside a herdr workspace gets titled from your first message.
 *   - tmux (fallback):   `tmux rename-window` + `select-pane -T` when pi is
 *     running inside tmux but not herdr.
 * No-ops in headless mode (`pi -p`), so background subagents spawned with an
 * inherited `TMUX_PANE`/`HERDR_PANE_ID` don't rename the parent.
 *
 * Refreshes the title on `agent_end` if `pi.getSessionName()` has been
 * updated (e.g. by `auto-session-name`, `/name`, or other extensions),
 * so the tab tracks the cleaned session name rather than staying on the
 * raw first-input truncation forever.
 *
 * `PI_TAB_LABEL` env override: when set (typically by the subagent spawner
 * for interactive herdr/tmux subagents), the title is pinned to that label
 * and never overwritten by the raw first input — which is usually a framed
 * subagent prompt whose preamble would otherwise show up as the tab title.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

/**
 * Decide which terminal/tab label wins, given a pinned override (`PI_TAB_LABEL`),
 * the current session name, and the raw first user input. Returns the label to
 * paint, or undefined when nothing should be painted yet.
 *
 * Precedence — this is the rule the three event handlers collectively enforce:
 *   1. pinned label  — authoritative; subagent spawner knows the task.
 *   2. session name  — set by auto-session-name / `/name` / other extensions.
 *   3. first input   — truncated fallback for ordinary interactive sessions.
 *
 * Exported as a pure function so the precedence rule can be unit-tested without
 * a live ExtensionAPI / tmux / terminal.
 */
export function resolveTitleLabel(opts: {
  pinnedLabel?: string;
  sessionName?: string;
  firstInput?: string;
  maxInput?: number;
}): string | undefined {
  const { pinnedLabel, sessionName, firstInput, maxInput = 40 } = opts;
  if (pinnedLabel) return pinnedLabel;
  if (sessionName) return sessionName;
  if (!firstInput?.trim()) return undefined;
  const clean = firstInput.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > maxInput ? clean.slice(0, maxInput) + "…" : clean;
}

/**
 * Compute the herdr CLI commands needed to paint `label` onto the pane (which
 * drives the terminal title) and its containing tab (which drives the tab
 * strip). Both must be renamed — renaming only the pane leaves the tab strip
 * showing its default numeric label ("1", "2", …), which is the user-visible
 * "tab name" in herdr.
 *
 * The `herdr` binary receives the ids it itself exported into the environment:
 * `HERDR_PANE_ID` and `HERDR_TAB_ID`. Returns commands in application order
 * (pane first, then tab) so a failure mid-sequence still leaves the pane named.
 * Returns an empty array when neither id is present (not running under herdr
 * in a way we can target).
 *
 * Exported as a pure function so the herdr wiring can be unit-tested without a
 * live `pi.exec` / herdr socket.
 */
export function buildHerdrRenameCommands(opts: {
  label: string;
  paneId?: string;
  tabId?: string;
}): Array<["pane" | "tab", string, string, string]> {
  const cmds: Array<["pane" | "tab", string, string, string]> = [];
  if (opts.paneId) cmds.push(["pane", "rename", opts.paneId, opts.label]);
  if (opts.tabId) cmds.push(["tab", "rename", opts.tabId, opts.label]);
  return cmds;
}

export default function (pi: ExtensionAPI) {
  let titled = false;
  let lastLabel: string | undefined;

  // Pinned label for subagent panes. Takes precedence over first-input / session
  // name so the tab reflects the task the spawner intended, not the framed prompt.
  const pinnedLabel = process.env.PI_TAB_LABEL?.trim() || undefined;

  // Backend detection. Prefer herdr when pi runs inside it: herdr manages its own
  // panes/tabs even when layered over tmux, so naming the herdr pane is the
  // correct lever for the user-visible tab. Falls back to tmux otherwise.
  const herdrPane = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
  const herdrTab = process.env.HERDR_ENV === "1" ? process.env.HERDR_TAB_ID : undefined;
  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = !herdrPane && !!process.env.TMUX && !!tmuxPane;
  let windowId: string | undefined;

  async function resolveWindowId() {
    if (!inTmux || windowId) return windowId;
    try {
      const { stdout, code } = await pi.exec("tmux", ["display-message", "-p", "-t", tmuxPane!, "#{window_id}"]);
      if (code === 0 && stdout?.trim()) windowId = stdout.trim();
    } catch (e) { console.debug("[auto-title]", e); }
    return windowId;
  }

  /** Paint `label` everywhere it should show: the terminal title (always), plus
   *  the host pane/tab title — herdr pane rename when inside herdr, tmux
   *  rename-window/select-pane otherwise. Idempotent: skips work when `label`
   *  equals the last painted label. */
  async function applyLabel(label: string, cwd: string, ctx: ExtensionContext) {
    const folder = basename(cwd) || cwd;
    const paneTitle = `π - ${folder} - ${label}`;
    ctx.ui.setTitle(paneTitle);

    if (herdrPane) {
      // Paint both the pane (terminal title) and the containing tab (tab
      // strip). Renaming the pane alone leaves the tab strip on its default
      // numeric label, which is the user-visible "tab name" in herdr.
      const cmds = buildHerdrRenameCommands({ label, paneId: herdrPane, tabId: herdrTab });
      for (const [sub, action, target, value] of cmds) {
        // e.g. `herdr pane rename w3:p1 <label>` then `herdr tab rename w3:t1 <label>`
        try { await pi.exec("herdr", [sub, action, target, value]); }
        catch (e) { console.debug(`[auto-title] herdr ${sub} rename`, e); }
      }
      lastLabel = label;
      return;
    }

    const target = await resolveWindowId();
    if (!target) { lastLabel = label; return; }
    try {
      await pi.exec("tmux", ["rename-window", "-t", target, label]);
      if (tmuxPane) {
        await pi.exec("tmux", ["select-pane", "-t", tmuxPane, "-T", paneTitle]);
      }
      lastLabel = label;
    } catch (e) { console.debug("[auto-title]", e); }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    titled = !!pi.getSessionName() || !!pinnedLabel;
    lastLabel = undefined;
    // Pin the tab name up front for subagent panes so the title is correct
    // before any input renders (and stays correct if the agent never settles).
    const initial = resolveTitleLabel({ pinnedLabel });
    if (initial) await applyLabel(initial, ctx.cwd, ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" as const };
    if (!event.text?.trim()) return { action: "continue" as const };
    // Pinned label owns the tab; don't let the framed first prompt override it.
    if (pinnedLabel) return { action: "continue" as const };
    if (!titled && !pi.getSessionName()) {
      const label = resolveTitleLabel({ firstInput: event.text });
      if (!label) return { action: "continue" as const };
      titled = true; // claim flag before the await so concurrent inputs don't double-paint
      await applyLabel(label, ctx.cwd, ctx);
    }
    return { action: "continue" as const };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const label = resolveTitleLabel({ pinnedLabel, sessionName: pi.getSessionName() });
    if (label && label !== lastLabel) await applyLabel(label, ctx.cwd, ctx);
  });
}