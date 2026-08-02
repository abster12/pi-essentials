// src/auto-title.ts
import { basename } from "node:path";

// src/title-summary.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "with",
  "without",
  "from",
  "by",
  "about",
  "as",
  "into",
  "over",
  "under",
  "between",
  "out",
  "up",
  "down",
  "off",
  "again",
  "further",
  "once",
  "here",
  "there",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "will",
  "just",
  "should",
  "would",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "having",
  "be",
  "been",
  "being",
  "am",
  "is",
  "are",
  "was",
  "were",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "them",
  "his",
  "her",
  "its",
  "their",
  "my",
  "your",
  "our",
  "me",
  "him",
  "us",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "how",
  "why",
  "when",
  "where",
  "please",
  "let",
  "make",
  "get",
  "need",
  "want",
  "like",
  "ok",
  "okay",
  "hey",
  "hi",
  "hello",
  "thanks",
  "thank",
  "actually",
  "basically",
  "really",
  "much",
  "many",
  "lot",
  "also",
  "even",
  "still",
  "already",
  "now",
  "ever",
  "never",
  "always",
  "sometimes",
  "im",
  "ive",
  "id",
  "youre",
  "youve",
  "thats",
  "theres",
  "whats",
  "whos",
  "dont",
  "doesnt",
  "didnt",
  "cant",
  "wont",
  "wouldnt",
  "couldnt",
  "shouldnt",
  "itll",
  "ill",
  "well",
  "hes",
  "shes",
  "theyre",
  "weve"
]);
function summarizeTitle(input, opts = {}) {
  const { maxWords = 4, maxChars = 40 } = opts;
  const seen = /* @__PURE__ */ new Set();
  const words = [];
  const tokens = input.toLowerCase().replace(/[\r\n]+/g, " ").replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t));
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(token);
    if (words.length >= maxWords) break;
  }
  if (words.length === 0) return "";
  let slug = words.join("-");
  while (slug.length > maxChars && words.length > 1) {
    words.pop();
    slug = words.join("-");
  }
  return slug.length > maxChars ? slug.slice(0, maxChars - 1) + "\u2026" : slug;
}
function titleFromPrompt(input, opts = {}) {
  const { maxChars = 40 } = opts;
  const clean = input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const summary = summarizeTitle(clean, opts);
  if (summary) return summary;
  return clean.length > maxChars ? clean.slice(0, maxChars) + "\u2026" : clean;
}

// src/auto-title.ts
function resolveTitleLabel(opts) {
  const { pinnedLabel, sessionName, firstInput } = opts;
  if (pinnedLabel) return pinnedLabel;
  if (sessionName) return sessionName;
  if (!firstInput?.trim()) return void 0;
  return titleFromPrompt(firstInput) || void 0;
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
