/**
 * oh-pi Auto Session Name Extension
 *
 * Automatically names sessions based on the first user message — as a short
 * hyphenated keyword slug ("fix-login-page") rather than a truncated
 * sentence, so session selectors and the auto-title tab stay readable.
 *
 * `PI_TAB_LABEL` env override: when set (by the subagent spawner for
 * interactive herdr/tmux subagents), the session is pre-named to that label
 * so the session selector and auto-title both show the task, not the framed
 * subagent prompt that arrives as the first user message.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { titleFromPrompt } from "./title-summary.js";

/**
 * The exact naming rule `agent_end` applies to the first user message:
 * the shared prompt → title policy (slug, else truncated fallback).
 * Exported so the session naming path is unit-testable without an
 * ExtensionAPI — the tab (auto-title) and session (this) agree by
 * construction, because both delegate to `titleFromPrompt`.
 */
export function nameFromFirstMessage(text: string): string {
  return titleFromPrompt(text);
}

/**
 * Decide what name (if any) a fresh session should start with, under the
 * same rules the `session_start` handler applies: a `PI_TAB_LABEL` override
 * wins when no explicit session name exists yet; otherwise the existing
 * session name is preserved. Exported for direct unit testing of the rule.
 */
export function resolveInitialSessionName(opts: {
  pinnedLabel?: string;
  sessionName?: string;
}): string | undefined {
  const { pinnedLabel, sessionName } = opts;
  if (sessionName) return undefined; // already named — never clobber
  if (pinnedLabel) return pinnedLabel;   // pin a still-unnamed session
  return undefined;
}

export default function (pi: ExtensionAPI) {
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
    const text = typeof userMsg.content === "string"
      ? userMsg.content
      : userMsg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ");
    if (!text) return;
    const name = nameFromFirstMessage(text);
    if (name) {
      pi.setSessionName(name);
      named = true;
    }
  });
}
