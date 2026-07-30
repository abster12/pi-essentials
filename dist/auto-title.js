// src/auto-title.ts
import { basename } from "node:path";
function resolveTitleLabel(opts) {
  const { pinnedLabel, sessionName, firstInput, maxInput = 40 } = opts;
  if (pinnedLabel) return pinnedLabel;
  if (sessionName) return sessionName;
  if (!firstInput?.trim()) return void 0;
  const clean = firstInput.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > maxInput ? clean.slice(0, maxInput) + "\u2026" : clean;
}
function buildHerdrRenameCommands(opts) {
  const cmds = [];
  if (opts.paneId) cmds.push(["pane", "rename", opts.paneId, opts.label]);
  if (opts.tabId) cmds.push(["tab", "rename", opts.tabId, opts.label]);
  return cmds;
}
function auto_title_default(pi) {
  let titled = false;
  let lastLabel;
  const pinnedLabel = process.env.PI_TAB_LABEL?.trim() || void 0;
  const herdrPane = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : void 0;
  const herdrTab = process.env.HERDR_ENV === "1" ? process.env.HERDR_TAB_ID : void 0;
  const tmuxPane = process.env.TMUX_PANE;
  const inTmux = !herdrPane && !!process.env.TMUX && !!tmuxPane;
  let windowId;
  async function resolveWindowId() {
    if (!inTmux || windowId) return windowId;
    try {
      const { stdout, code } = await pi.exec("tmux", ["display-message", "-p", "-t", tmuxPane, "#{window_id}"]);
      if (code === 0 && stdout?.trim()) windowId = stdout.trim();
    } catch (e) {
      console.debug("[auto-title]", e);
    }
    return windowId;
  }
  async function applyLabel(label, cwd, ctx) {
    const folder = basename(cwd) || cwd;
    const paneTitle = `\u03C0 - ${folder} - ${label}`;
    ctx.ui.setTitle(paneTitle);
    if (herdrPane) {
      const cmds = buildHerdrRenameCommands({ label, paneId: herdrPane, tabId: herdrTab });
      for (const [sub, action, target2, value] of cmds) {
        try {
          await pi.exec("herdr", [sub, action, target2, value]);
        } catch (e) {
          console.debug(`[auto-title] herdr ${sub} rename`, e);
        }
      }
      lastLabel = label;
      return;
    }
    const target = await resolveWindowId();
    if (!target) {
      lastLabel = label;
      return;
    }
    try {
      await pi.exec("tmux", ["rename-window", "-t", target, label]);
      if (tmuxPane) {
        await pi.exec("tmux", ["select-pane", "-t", tmuxPane, "-T", paneTitle]);
      }
      lastLabel = label;
    } catch (e) {
      console.debug("[auto-title]", e);
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    titled = !!pi.getSessionName() || !!pinnedLabel;
    lastLabel = void 0;
    const initial = resolveTitleLabel({ pinnedLabel });
    if (initial) await applyLabel(initial, ctx.cwd, ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" };
    if (!event.text?.trim()) return { action: "continue" };
    if (pinnedLabel) return { action: "continue" };
    if (!titled && !pi.getSessionName()) {
      const label = resolveTitleLabel({ firstInput: event.text });
      if (!label) return { action: "continue" };
      titled = true;
      await applyLabel(label, ctx.cwd, ctx);
    }
    return { action: "continue" };
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const label = resolveTitleLabel({ pinnedLabel, sessionName: pi.getSessionName() });
    if (label && label !== lastLabel) await applyLabel(label, ctx.cwd, ctx);
  });
}
export {
  buildHerdrRenameCommands,
  auto_title_default as default,
  resolveTitleLabel
};
//# sourceMappingURL=auto-title.js.map
