import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeTitle, titleFromPrompt } from "../title-summary.js";

/**
 * Tests for the shared prompt → title policy that turns a long first prompt
 * into a short hyphenated tab/session title ("auto-title-tab-fix" instead of
 * "we have auto naming of the herdr tab but that see…").
 *
 * `titleFromPrompt` is the single owner of the whole policy (normalize →
 * slug → fallback); `summarizeTitle` is the lower-level slugger it delegates
 * to. Shared by auto-title (tab labels) and auto-session-name (session
 * names), so a regression here shows up as an unreadable title twice over.
 */

describe("titleFromPrompt", () => {
  it("normalizes whitespace before summarizing", () => {
    assert.equal(titleFromPrompt("fix\n\n  login   page"), "fix-login-page");
  });

  it("returns the keyword slug for a long prompt", () => {
    const prompt = "we have auto naming of the herdr tab but that seems to be " +
      "taking the whole prompt and then truncating it";
    assert.equal(titleFromPrompt(prompt), "auto-naming-herdr-tab");
  });

  it("falls back to cleaned text when the slug is empty (short input)", () => {
    assert.equal(titleFromPrompt("hi there"), "hi there");
    assert.equal(titleFromPrompt("the and of with to in"), "the and of with to in");
  });

  it("falls back to ellipsis truncation at maxChars (long stopword-only)", () => {
    const long = "the and of with to in ".repeat(8).trim();
    assert.equal(titleFromPrompt(long), long.slice(0, 40) + "…");
  });

  it("applies the same maxChars to the slug and the fallback", () => {
    // Slug path: shrinks to fit maxChars.
    assert.equal(titleFromPrompt("docker compose postgres migration", { maxChars: 20 }), "docker-compose");
    // Fallback path: truncates at the same limit.
    assert.equal(titleFromPrompt("of the with in ".repeat(6), { maxChars: 20 }), "of the with in of the with".slice(0, 20) + "…");
  });

  it("returns empty string only for empty/whitespace input", () => {
    assert.equal(titleFromPrompt(""), "");
    assert.equal(titleFromPrompt("   \n  "), "");
  });
});

describe("summarizeTitle", () => {
  it("returns the first few content words joined by hyphens", () => {
    assert.equal(summarizeTitle("fix the login page"), "fix-login-page");
  });

  it("splits hyphenated compounds so keywords count individually", () => {
    assert.equal(summarizeTitle("update the auto-title-tab extension"), "update-auto-title-tab");
  });

  it("respects maxWords", () => {
    assert.equal(
      summarizeTitle("migrate the postgres schema and add indexes", { maxWords: 3 }),
      "migrate-postgres-schema",
    );
  });

  it("dedupes repeated words keeping first occurrence", () => {
    assert.equal(summarizeTitle("check the logs then check the config"), "check-logs-config");
  });

  it("ignores punctuation and case", () => {
    assert.equal(summarizeTitle("EXPLAIN foo() BAR?!"), "explain-foo-bar");
  });

  it("drops single letters but keeps meaningful digits", () => {
    assert.equal(summarizeTitle("upgrade go to 1.25"), "upgrade-go-25");
  });

  it("shrinks to maxChars by dropping trailing words", () => {
    assert.equal(
      summarizeTitle("docker compose postgres migration schema", { maxChars: 20 }),
      "docker-compose",
    );
  });

  it("hard-truncates a single oversized word", () => {
    assert.equal(
      summarizeTitle("supercalifragilisticexpialidocious", { maxChars: 15 }),
      "supercalifragi…",
    );
  });

  it("returns empty string for stopword-only input", () => {
    assert.equal(summarizeTitle("the and of with to in"), "");
    assert.equal(summarizeTitle("hi there how are you"), "");
  });

  it("returns empty string for empty or whitespace input", () => {
    assert.equal(summarizeTitle(""), "");
    assert.equal(summarizeTitle("   \n  "), "");
  });
});
