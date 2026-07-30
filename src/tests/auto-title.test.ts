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

    it("falls back to truncated first input when nothing else is set", () => {
      assert.equal(
        resolveTitleLabel({ firstInput: "add a login page" }),
        "add a login page",
      );
    });

    it("returns undefined when there is nothing to show yet", () => {
      assert.equal(resolveTitleLabel({}), undefined);
      assert.equal(resolveTitleLabel({ firstInput: "   " }), undefined);
      assert.equal(resolveTitleLabel({ firstInput: "" }), undefined);
    });
  });

  describe("first-input truncation", () => {
    it("truncates with an ellipsis past the max", () => {
      const long = "x".repeat(50);
      const out = resolveTitleLabel({ firstInput: long, maxInput: 40 });
      assert.equal(out, "x".repeat(40) + "…");
    });

    it("respects a custom maxInput", () => {
      const out = resolveTitleLabel({ firstInput: "abcdefghij", maxInput: 5 });
      assert.equal(out, "abcde…");
    });

    it("collapses newlines and runs of whitespace before measuring", () => {
      assert.equal(
        resolveTitleLabel({ firstInput: "hello\n\n  world   again" }),
        "hello world again",
      );
    });

    it("does not truncate input shorter than the max", () => {
      assert.equal(resolveTitleLabel({ firstInput: "short", maxInput: 40 }), "short");
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