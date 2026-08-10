import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handoffDir,
  handoffPath,
  handoffSlug,
  isHandoffConsumed,
  listHandoffDocs,
  markConsumed,
  readState,
  renderGitState,
  unreadHandoffDocs,
  writeState,
  type GitState,
  type HandoffState,
} from "../handoff.js";

/**
 * Tests for the handoff extension's pure helpers: slug/path resolution,
 * doc discovery, and the mechanical git-state block rendered into every
 * handoff doc (and injected at resume time).
 */

test("handoffSlug turns a topic into a hyphenated slug", () => {
  assert.equal(handoffSlug("fix the login page"), "fix-login-page");
  assert.equal(handoffSlug("decompose the subagent megamodule"), "decompose-subagent-megamodule");
  assert.equal(handoffSlug(""), "untitled");
  assert.equal(handoffSlug("hi there"), "untitled"); // stopword-only → untitled
});

test("handoffPath points into handoff/ with handoff- prefix", () => {
  assert.equal(handoffPath("/proj", "fix the login page"), "/proj/handoff/handoff-fix-login-page.md");
});

test("handoffDir defaults to <cwd>/handoff and honors PI_HANDOFF_DIR", () => {
  const prev = process.env.PI_HANDOFF_DIR;
  try {
    delete process.env.PI_HANDOFF_DIR;
    assert.equal(handoffDir("/proj"), "/proj/handoff");
    process.env.PI_HANDOFF_DIR = "/abs/dir";
    assert.equal(handoffDir("/proj"), "/abs/dir");
  } finally {
    if (prev === undefined) delete process.env.PI_HANDOFF_DIR;
    else process.env.PI_HANDOFF_DIR = prev;
  }
});

test("listHandoffDocs returns markdown docs sorted by mtime desc", async () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-test-"));
  try {
    writeFileSync(join(dir, "handoff-a.md"), "a");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, "handoff-b.md"), "b");
    writeFileSync(join(dir, "notes.txt"), "x");
    const docs = listHandoffDocs(dir);
    assert.equal(docs.length, 2);
    assert.ok(docs[0].file.endsWith("handoff-b.md")); // newest first
    assert.ok(docs[1].file.endsWith("handoff-a.md"));
    assert.ok(docs[0].mtime >= docs[1].mtime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listHandoffDocs returns [] for missing dirs", () => {
  assert.deepEqual(listHandoffDocs("/nonexistent/handoff-dir"), []);
});

test("renderGitState formats a clean repo", () => {
  const clean: GitState = { branch: "main", status: undefined, diffStat: undefined, commits: undefined };
  const out = renderGitState(clean);
  assert.ok(out.includes("- Branch: main"));
  assert.ok(out.includes("(clean)"));
  assert.ok(out.includes("(no uncommitted diff)"));
  assert.ok(out.includes("(none)"));
});

test("renderGitState formats a dirty repo with indented blocks", () => {
  const dirty: GitState = {
    branch: "fix-login",
    status: " M src/a.ts\n?? b.ts",
    diffStat: "src/a.ts | 2 +-",
    commits: "abc1230 fix login flow\nc0ff9d0 durable subagents",
  };
  const out = renderGitState(dirty);
  assert.ok(out.includes("- Branch: fix-login"));
  assert.ok(out.includes("  M src/a.ts"));
  assert.ok(out.includes("  ?? b.ts"));
  assert.ok(out.includes("  src/a.ts | 2 +-"));
  assert.ok(out.includes("  abc1230 fix login flow"));
});

test("renderGitState caps long blocks with a marker", () => {
  const many = Array.from({ length: 50 }, (_, i) => ` M file-${i}.ts`).join("\n");
  const out = renderGitState({ branch: "main", status: many });
  assert.ok(out.includes("(+10 more)"));
});

test("renderGitState reports missing git", () => {
  const out = renderGitState({});
  assert.ok(out.includes("(not a git repo)"));
});

test("isHandoffConsumed hides docs resumed after their last write", () => {
  const state: HandoffState = { consumed: { "handoff-a.md": 2000 } };
  // resumed (2000) after write (1000) → consumed
  assert.equal(isHandoffConsumed(state, "/d/handoff-a.md", 1000), true);
  // modified (3000) after resume (2000) → a fresh handoff, surface again
  assert.equal(isHandoffConsumed(state, "/d/handoff-a.md", 3000), false);
  // never resumed → unread
  assert.equal(isHandoffConsumed(state, "/d/handoff-b.md", 1000), false);
  assert.equal(isHandoffConsumed({ consumed: {} }, "/d/handoff-c.md", 1000), false);
});

test("unreadHandoffDocs filters consumed docs, keeping order", () => {
  const docs = [
    { file: "/d/handoff-a.md", mtime: 1000 },
    { file: "/d/handoff-b.md", mtime: 3000 },
  ];
  const state: HandoffState = { consumed: { "handoff-a.md": 2000 } };
  const unread = unreadHandoffDocs(state, docs);
  assert.equal(unread.length, 1);
  assert.ok(unread[0].file.endsWith("handoff-b.md"));
});

test("markConsumed persists across readState round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-state-1-"));
  try {
    writeFileSync(join(dir, "handoff-a.md"), "a");
    markConsumed(dir, "handoff-a.md");
    const state = readState(dir);
    assert.equal(typeof state.consumed["handoff-a.md"], "number");
    // resuming again just refreshes the timestamp
    const first = state.consumed["handoff-a.md"];
    markConsumed(dir, "handoff-a.md");
    assert.ok(readState(dir).consumed["handoff-a.md"] >= first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readState prunes entries for docs that no longer exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-state-2-"));
  try {
    writeFileSync(join(dir, "handoff-a.md"), "a");
    markConsumed(dir, "handoff-a.md");
    rmSync(join(dir, "handoff-a.md"));
    assert.deepEqual(readState(dir).consumed, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeState tolerates unwritable dirs", () => {
  writeState("/nonexistent-xyz/handoff", { consumed: { "a.md": 1 } });
  assert.deepEqual(readState("/nonexistent-xyz/handoff").consumed, {});
});
