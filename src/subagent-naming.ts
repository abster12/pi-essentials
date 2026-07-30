/**
 * Naming helpers for the subagent extension.
 *
 * Extracted so unit tests can import pure logic without peer deps.
 * Powers herdr pane/tab/agent names and tmux window names via uniqueLabel().
 */

/** Herdr rejects agent names outside 1–32 chars of `[a-z][a-z0-9_-]*`. */
export const HERDR_AGENT_NAME_MAX = 32;

/** Derive a short, filesystem/tab-safe slug from a free-text task.
 *  Used to name herdr panes (tabs) and agents after the work itself, so the
 *  user sees `review-auth-module` instead of `subagent-1f3a2b`.
 *  Returns "" if the task has no usable word (caller falls back to the id). */
export function taskSlug(task: string, max = 28): string {
  const s = task
    .toLowerCase()
    // Turn any non-alphanumeric run (path separators, punctuation, dots) into a
    // space so words stay separated — e.g. "src/parser.ts" → "src-parser-ts",
    // not a glued "srcparserts".
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return s.slice(0, max).replace(/-+$/, "");
}

/** Sanitize a caller-supplied subagent id into a short alphanumeric suffix. */
export function idSlug(id: string, max = 6): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, max) || "x";
}

/**
 * Unique, herdr-safe label for tabs / tmux windows / agents.
 * Shape: `<task-slug>-<id-suffix>`, always ≤ `max` (default 32), always starts
 * with a letter, unique per subagent id so concurrent same-task runs don't
 * collide on tmux window names or herdr agent names.
 */
export function uniqueLabel(task: string, id: string, max = HERDR_AGENT_NAME_MAX): string {
  const suffix = idSlug(id, 6);
  const baseBudget = Math.max(1, max - 1 - suffix.length);
  let base = taskSlug(task, baseBudget);
  if (!base) base = taskSlug(`subagent ${id}`, baseBudget) || "sa";
  // Herdr requires a leading lowercase letter.
  if (!/^[a-z]/.test(base)) base = `a${base}`.slice(0, baseBudget);
  return `${base}-${suffix}`.slice(0, max).replace(/-+$/, "");
}
