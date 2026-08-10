/**
 * Shared relative-time formatting for saved-doc listing UIs
 * (subagent crash files, handoff docs).
 */
export function relativeTime(ms: number): string {
  const ago = Date.now() - ms;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}
