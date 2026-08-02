import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveInitialSessionName, nameFromFirstMessage } from "../auto-session-name.js";

/**
 * Tests for the session-name seeding rule applied on `session_start`.
 *
 * `resolveInitialSessionName` encodes the real rule: never clobber an existing
 * session name; pin an unnamed session to `PI_TAB_LABEL` when the subagent
 * spawner set it. A regression here means either auto-session-name fights
 * auto-title (wrong tab title), or a `/name`-d session gets renamed on reload.
 */
describe("resolveInitialSessionName", () => {
  it("pins an unnamed session to the provided label", () => {
    assert.equal(resolveInitialSessionName({ pinnedLabel: "review-auth" }), "review-auth");
  });

  it("does NOT clobber an existing session name (returns undefined)", () => {
    // A session named via /name or resume must survive the pin check.
    assert.equal(
      resolveInitialSessionName({ pinnedLabel: "review-auth", sessionName: "already named" }),
      undefined,
    );
  });

  it("returns undefined when nothing is set (no pin, no existing name)", () => {
    assert.equal(resolveInitialSessionName({}), undefined);
  });

  it("returns undefined when a session name exists but no pin is set", () => {
    assert.equal(resolveInitialSessionName({ sessionName: "named" }), undefined);
  });

  it("returns the raw pin (caller is responsible for trimming)", () => {
    // The extension trims via `PI_TAB_LABEL?.trim() || undefined` before
    // calling, so an empty string never reaches this function in production.
    // It trusts its caller and returns the value verbatim — document that.
    assert.equal(resolveInitialSessionName({ pinnedLabel: "pinned" }), "pinned");
  });
});

/**
 * Tests for the agent_end naming rule: `nameFromFirstMessage` is exactly
 * what the session path calls, so the session name and the auto-title tab
 * label agree by construction — both delegate to `titleFromPrompt`.
 */
describe("nameFromFirstMessage", () => {
  it("names a session with the same keyword slug the tab gets", () => {
    const prompt = "we have auto naming of the herdr tab but that seems to be " +
      "taking the whole prompt and then truncating it";
    assert.equal(nameFromFirstMessage(prompt), "auto-naming-herdr-tab");
  });

  it("falls back to truncated text for stopword-only messages", () => {
    const long = "the and of with to in ".repeat(8).trim();
    assert.equal(nameFromFirstMessage(long), long.slice(0, 40) + "…");
  });

  it("returns empty string for empty messages (caller guards)", () => {
    assert.equal(nameFromFirstMessage("   "), "");
  });
});