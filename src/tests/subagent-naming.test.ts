import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { taskSlug, idSlug, uniqueLabel, HERDR_AGENT_NAME_MAX } from "../subagent-naming.ts";

/**
 * Tests for the task→slug derivation used to name herdr panes/tabs/agents and
 * tmux windows. This is real production logic (not a simulation): `taskSlug`
 * powers every interactive subagent's tab label, so a bad slug means a
 * garbage tab name in the user's terminal.
 */
describe("taskSlug", () => {
  it("turns a plain sentence into dash-joined words", () => {
    assert.equal(taskSlug("review the auth module"), "review-the-auth-module");
  });

  it("turns path separators and punctuation into word separators", () => {
    // `src/parser.ts` must stay separated — not glued into "srcparserts".
    assert.equal(taskSlug("Fix bug #123 in src/parser.ts!"), "fix-bug-123-in-src-parser");
  });

  it("collapses repeated separators", () => {
    assert.equal(taskSlug("do   ---   something"), "do-something");
  });

  it("trims leading/trailing separators after cleaning", () => {
    assert.equal(taskSlug("   --- clean me ---   "), "clean-me");
  });

  it("respects the max length cap without a trailing dash", () => {
    const long = "alpha beta gamma delta epsilon zeta eta theta";
    const out = taskSlug(long);
    assert.ok(out.length <= 28, `slug "${out}" exceeded 28 chars`);
    assert.ok(!out.endsWith("-"), `slug "${out}" ended with a dangling dash`);
  });

  it("caps at the requested max when provided", () => {
    // 10 chars: "alpha-beta" (9) — under cap, no truncation.
    assert.equal(taskSlug("alpha beta gamma delta", 10), "alpha-beta");
    // 5 chars: "alpha" (5) — exactly at cap, no trailing dash.
    assert.equal(taskSlug("alpha beta gamma", 5), "alpha");
  });

  it("limits to the first six words before truncating", () => {
    // Six words, total 23 chars — under the 28 cap, so no truncation.
    assert.equal(taskSlug("one two three four five six seven"), "one-two-three-four-five-six");
  });

  it("returns empty string when the task has no usable word", () => {
    assert.equal(taskSlug("!!! ??? ---"), "");
    assert.equal(taskSlug("   "), "");
    assert.equal(taskSlug(""), "");
  });

  it("is lowercase only", () => {
    assert.equal(taskSlug("Review The AUTH Module"), "review-the-auth-module");
  });
});

describe("idSlug", () => {
  it("lowercases and strips non-alphanumerics", () => {
    assert.equal(idSlug("CR-Review"), "crrevi");
  });

  it("falls back to x when the id has no usable chars", () => {
    assert.equal(idSlug("!!!"), "x");
    assert.equal(idSlug(""), "x");
  });
});

describe("uniqueLabel", () => {
  const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

  it("stays within herdr's 32-char agent-name limit", () => {
    const long =
      "review the authentication module thoroughly for security vulnerabilities and edge cases";
    const out = uniqueLabel(long, "auth-review");
    assert.ok(out.length <= HERDR_AGENT_NAME_MAX, `label "${out}" exceeded ${HERDR_AGENT_NAME_MAX}`);
    assert.match(out, HERDR_NAME);
  });

  it("embeds an id suffix so same-task runs stay unique", () => {
    const a = uniqueLabel("review auth", "run-aaa");
    const b = uniqueLabel("review auth", "run-bbb");
    assert.notEqual(a, b);
    assert.ok(a.includes("runaaa"), `expected id suffix in "${a}"`);
    assert.ok(b.includes("runbbb"), `expected id suffix in "${b}"`);
  });

  it("never ends with a dangling dash after truncation", () => {
    const out = uniqueLabel("alpha beta gamma delta epsilon zeta", "zzzzzz");
    assert.ok(!out.endsWith("-"), `label "${out}" ended with a dangling dash`);
    assert.ok(out.length <= HERDR_AGENT_NAME_MAX);
  });

  it("falls back to a letter-led base when the task has no words", () => {
    const out = uniqueLabel("!!!", "cr");
    assert.match(out, HERDR_NAME);
    assert.ok(out.includes("cr"), `expected id in "${out}"`);
  });

  it("is safe to use as both tab label and herdr agent name", () => {
    const out = uniqueLabel("review the auth module", "cr-1");
    assert.equal(out, uniqueLabel("review the auth module", "cr-1"));
    assert.match(out, HERDR_NAME);
  });
});
