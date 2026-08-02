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

// src/auto-session-name.ts
function nameFromFirstMessage(text) {
  return titleFromPrompt(text);
}
function resolveInitialSessionName(opts) {
  const { pinnedLabel, sessionName } = opts;
  if (sessionName) return void 0;
  if (pinnedLabel) return pinnedLabel;
  return void 0;
}
function auto_session_name_default(pi) {
  let named = false;
  pi.on("session_start", async (_event, _ctx) => {
    const pinned = process.env.PI_TAB_LABEL?.trim();
    const initial = resolveInitialSessionName({ pinnedLabel: pinned, sessionName: pi.getSessionName() });
    if (initial) {
      pi.setSessionName(initial);
    }
    named = !!pi.getSessionName();
  });
  pi.on("agent_end", async (event) => {
    if (named) return;
    const userMsg = event.messages.find((m) => m.role === "user");
    if (!userMsg) return;
    const text = typeof userMsg.content === "string" ? userMsg.content : userMsg.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    if (!text) return;
    const name = nameFromFirstMessage(text);
    if (name) {
      pi.setSessionName(name);
      named = true;
    }
  });
}
export {
  auto_session_name_default as default,
  nameFromFirstMessage,
  resolveInitialSessionName
};
//# sourceMappingURL=auto-session-name.js.map
