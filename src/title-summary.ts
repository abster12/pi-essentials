/**
 * Title Summary
 *
 * Shared title policy used by auto-title (tab labels) and auto-session-name
 * (session names) so a long first prompt becomes a short hyphenated slug —
 * e.g. "auto-title-tab-fix" — instead of a raw truncated sentence
 * ("we have auto naming of the herdr tab but that see…").
 *
 * `titleFromPrompt` is the single owner of the whole prompt → title policy:
 * normalize whitespace → keyword slug → truncation fallback. Both extensions
 * call it and nothing else. `summarizeTitle` is the lower-level slugger it
 * delegates to, kept exported for focused unit tests.
 *
 * Pure text in, slug out. No LLM calls, no async, deterministic.
 */

/** Words too common to carry meaning for a tab/session title. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for", "to", "of",
  "in", "on", "at", "with", "without", "from", "by", "about", "as", "into",
  "over", "under", "between", "out", "up", "down", "off", "again", "further",
  "once", "here", "there", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "can", "will", "just", "should", "would", "could",
  "may", "might", "must", "shall", "do", "does", "did", "have", "has", "had",
  "having", "be", "been", "being", "am", "is", "are", "was", "were", "i",
  "you", "he", "she", "it", "we", "they", "them", "his", "her", "its", "their",
  "my", "your", "our", "me", "him", "us", "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose", "how", "why", "when", "where",
  "please", "let", "make", "get", "need", "want", "like", "ok", "okay", "hey",
  "hi", "hello", "thanks", "thank", "actually", "basically", "really", "much",
  "many", "lot", "also", "even", "still", "already", "now", "ever",
  "never", "always", "sometimes", "im", "ive", "id", "youre", "youve",
  "thats", "theres", "whats", "whos", "dont", "doesnt", "didnt", "cant",
  "wont", "wouldnt", "couldnt", "shouldnt", "itll", "ill", "well", "hes",
  "shes", "theyre", "weve",
]);

export interface SummarizeOptions {
  /** Maximum number of hyphenated words (default 4). */
  maxWords?: number;
  /** Maximum total slug length; trailing words are dropped to fit (default 40). */
  maxChars?: number;
}

export function summarizeTitle(input: string, opts: SummarizeOptions = {}): string {
  const { maxWords = 4, maxChars = 40 } = opts;
  const seen = new Set<string>();
  const words: string[] = [];

  const tokens = input
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    // Everything that isn't a letter/digit is a separator — punctuation and
    // hyphens included, so compound keywords split into individual words.
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(token);
    if (words.length >= maxWords) break;
  }

  if (words.length === 0) return "";
  let slug = words.join("-");
  // Shrink to fit: drop trailing words first, then hard-truncate as a last resort.
  while (slug.length > maxChars && words.length > 1) {
    words.pop();
    slug = words.join("-");
  }
  return slug.length > maxChars ? slug.slice(0, maxChars - 1) + "…" : slug;
}

/**
 * Full prompt → title policy. The one function both extensions call; there is
 * no divergent fallback logic at the call sites.
 *
 *   1. Normalize whitespace (newlines → space, collapse runs, trim).
 *   2. Try the keyword slug (`maxWords` = 4).
 *   3. If the slug is empty (stopword-only / no content words), fall back to
 *      the cleaned text truncated at `maxChars` (40) with an ellipsis.
 *   4. Returns "" only when the input is empty/whitespace after cleaning.
 */
export function titleFromPrompt(input: string, opts: SummarizeOptions = {}): string {
  const { maxChars = 40 } = opts;
  const clean = input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const summary = summarizeTitle(clean, opts);
  if (summary) return summary;
  return clean.length > maxChars ? clean.slice(0, maxChars) + "…" : clean;
}
