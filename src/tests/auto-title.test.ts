import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTitleLabel, buildHerdrRenameCommands } from "../auto-title.js";

/**
 * Tests for the label precedence rule that drives tmux/herdr tab naming.
 *
 * This is the actual production rule (not a simulation): `resolveTitleLabel` is
 * the pure core that the `input`/`agent_end` handlers in auto-title.ts consult.
 * A regression here means the wrong thing ends up as your terminal tab title —
 * e.g. a subagent's framed prompt preamble leaking through, or a `/name`-set
 * session name being ignored.
 */
describe("resolveTitleLabel", () => {
  describe("precedence", () => {
    it("pinned label wins over session name and first input", () => {
      assert.equal(
        resolveTitleLabel({ pinnedLabel: "review-auth", sessionName: "earlier name", firstInput: "hey" }),
        "review-auth",
      );
    });

    it("session name wins over first input when no pin", () => {
      assert.equal(
        resolveTitleLabel({ sessionName: "named session", firstInput: "first message" }),
        "named session",
      );
    });

    it("summarizes the first input into a keyword slug", () => {
      assert.equal(
        resolveTitleLabel({ firstInput: "add a login page" }),
        "add-login-page",
      );
    });

    it("returns undefined when there is nothing to show yet", () => {
      assert.equal(resolveTitleLabel({}), undefined);
      assert.equal(resolveTitleLabel({ firstInput: "   " }), undefined);
      assert.equal(resolveTitleLabel({ firstInput: "" }), undefined);
    });
  });

  describe("first-input title", () => {
    // Golden intent: the original complaint prompt must become a short
    // hyphenated slug, not a truncated sentence.
    it("turns the original long prompt into auto-naming-herdr-tab", () => {
      const prompt = "we have auto naming of the herdr tab but that seems to be " +
        "taking the whole prompt and then truncating it, what's the cheapest " +
        "and easiest way we can summarise the prompt into hyphenated words";
      assert.equal(resolveTitleLabel({ firstInput: prompt }), "auto-naming-herdr-tab");
    });

    // Fallback policy (slug-empty cases) lives in titleFromPrompt; assert it
    // once here to prove resolveTitleLabel hands through unchanged.
    it("passes through stopword-only input untouched when short", () => {
      assert.equal(resolveTitleLabel({ firstInput: "hi there" }), "hi there");
    });
  });

  describe("pinned label is authoritative", () => {
    it("ignores first input entirely when pinned", () => {
      assert.equal(
        resolveTitleLabel({ pinnedLabel: "pinned", firstInput: "x".repeat(200) }),
        "pinned",
      );
    });

    it("returns the pin even when session name is absent", () => {
      assert.equal(resolveTitleLabel({ pinnedLabel: "pinned" }), "pinned");
    });
  });
});

/**
 * Tests for the herdr command sequence `auto-title` runs when painting a
 * label. The tab strip in herdr is a distinct object from the pane: renaming
 * only the pane (terminal title) leaves the tab on its default numeric label
 * (`"1"`, `"2"`, …). This is the regression that made tabs stay on `1` even
 * though the pane had been renamed.
 */
describe("buildHerdrRenameCommands", () => {
  it("issues pane rename then tab rename so both track the label", () => {
    assert.deepEqual(
      buildHerdrRenameCommands({ label: "review-auth", paneId: "w3:p1", tabId: "w3:t1" }),
      [
        ["pane", "rename", "w3:p1", "review-auth"],
        ["tab", "rename", "w3:t1", "review-auth"],
      ],
    );
  });

  it("omits the tab rename when HERDR_TAB_ID is missing", () => {
    // Pane-only still useful (terminal title), but tab strip stays default.
    assert.deepEqual(
      buildHerdrRenameCommands({ label: "run tests", paneId: "w3:p1" }),
      [["pane", "rename", "w3:p1", "run tests"]],
    );
  });

  it("omits the pane rename when only the tab id is present", () => {
    assert.deepEqual(
      buildHerdrRenameCommands({ label: "run tests", tabId: "w3:t1" }),
      [["tab", "rename", "w3:t1", "run tests"]],
    );
  });

  it("returns nothing when neither id is available", () => {
    assert.deepEqual(buildHerdrRenameCommands({ label: "x" }), []);
  });

  it("always runs pane rename before tab rename", () => {
    // Pane first so the terminal-title repaint isn't gated on the tab rename.
    const cmds = buildHerdrRenameCommands({ label: "x", paneId: "w3:p1", tabId: "w3:t1" });
    assert.equal(cmds[0][0], "pane");
    assert.equal(cmds[1][0], "tab");
  });
});