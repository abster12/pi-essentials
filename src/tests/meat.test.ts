import { test } from "node:test";
import assert from "node:assert/strict";
import {
  meatArgs,
  meatSourceLabel,
  buildDocument,
  formatMeatReadingDiff,
  parseMeatReadingDiff,
  fenceCodeBlock,
  softWrapLine,
  softWrapReadingDiff,
  MEAT_SOFT_WRAP_WIDTH,
  MEAT_SOFT_WRAP_CONTINUATION,
  parseCommandArgs,
  classifyAnnotationResult,
  requestAnnotation,
  isPlannotatorAvailable,
  raceHangGuards,
} from "../meat";

/** A fake emitter that captures the request and lets the test drive `respond`. */
function makeEmitter() {
  let captured: { channel: string; data: any } | undefined;
  const emit = (channel: string, data: unknown) => {
    captured = { channel, data };
  };
  return { emit, captured: () => captured };
}

test("meatArgs maps params to meat CLI args", () => {
  assert.deepEqual(meatArgs({}), []);
  assert.deepEqual(meatArgs({ revision: "HEAD~2" }), ["HEAD~2"]);
  assert.deepEqual(meatArgs({ revision: "a..b" }), ["a..b"]);
  assert.deepEqual(meatArgs({ staged: true }), ["-staged"]);
  assert.deepEqual(meatArgs({ working: true }), ["-w"]);
  assert.deepEqual(meatArgs({ revision: "  main...HEAD  " }), ["main...HEAD"]);
  // staged wins over working; revision still passes through
  assert.deepEqual(meatArgs({ staged: true, working: true }), ["-staged"]);
  assert.deepEqual(meatArgs({ staged: true, revision: "HEAD" }), ["-staged", "HEAD"]);
  assert.deepEqual(meatArgs({ noCache: true }), ["-no-cache"]);
  assert.deepEqual(meatArgs({ noCache: true, staged: true }), ["-no-cache", "-staged"]);
  assert.equal(meatSourceLabel({}), "meat (HEAD)");
  assert.equal(meatSourceLabel({ staged: true }), "meat -staged");
});

test("parseMeatReadingDiff splits summary and per-file hunks", () => {
  const raw = [
    "# Documents the Meat flows",
    "# kept 2/4 changed lines in 2/2 files",
    "",
    "diff --git a/README.md b/README.md",
    "index aaa..bbb 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,0 +1,1 @@",
    "+| **Meat** | docs |",
    " ## What's new",
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "+      \"./dist/meat.js\"",
  ].join("\n");
  const parsed = parseMeatReadingDiff(raw);
  assert.deepEqual(parsed.summaryLines, [
    "Documents the Meat flows",
    "kept 2/4 changed lines in 2/2 files",
  ]);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0]!.path, "README.md");
  assert.equal(parsed.files[1]!.path, "package.json");
  assert.match(parsed.files[0]!.body, /\+\| \*\*Meat\*\*/);
});

test("formatMeatReadingDiff wraps the whole reading diff in one code fence", () => {
  const raw = [
    "# Summary of the change",
    "# kept 1/1 changed lines in 1/1 files",
    "",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "+| **Meat** | docs |",
    " ## What's new",
  ].join("\n");
  const formatted = formatMeatReadingDiff(raw);
  assert.match(formatted, /^```diff\n/);
  assert.match(formatted, /\n```\n$/);
  // Raw meat lines stay inside the fence — no pipe escaping, no blank-line smash.
  assert.ok(formatted.includes("+| **Meat** | docs |"));
  assert.ok(formatted.includes(" ## What's new"));
  assert.ok(!formatted.includes("+\\|"));
});

test("softWrapLine leaves short lines alone and wraps long ones with continuation", () => {
  assert.deepEqual(softWrapLine("short"), ["short"]);
  assert.deepEqual(softWrapLine("x".repeat(MEAT_SOFT_WRAP_WIDTH)), ["x".repeat(MEAT_SOFT_WRAP_WIDTH)]);

  const long = "+| " + "word ".repeat(40).trim(); // well over 100 cols
  const wrapped = softWrapLine(long);
  assert.ok(wrapped.length >= 2);
  assert.ok(wrapped[0]!.startsWith("+| "));
  assert.ok(wrapped[0]!.length <= MEAT_SOFT_WRAP_WIDTH);
  for (let i = 1; i < wrapped.length; i++) {
    assert.ok(wrapped[i]!.startsWith(MEAT_SOFT_WRAP_CONTINUATION));
    assert.ok(wrapped[i]!.length <= MEAT_SOFT_WRAP_WIDTH);
  }
  // Logical content preserved (spaces may collapse at break points).
  const rejoined = wrapped.map((l, i) => (i === 0 ? l : l.slice(MEAT_SOFT_WRAP_CONTINUATION.length))).join(" ");
  assert.equal(rejoined.replace(/\s+/g, " "), long.replace(/\s+/g, " "));
});

test("softWrapLine hard-breaks oversized tokens without spaces", () => {
  const token = "a".repeat(MEAT_SOFT_WRAP_WIDTH + 25);
  const wrapped = softWrapLine(token);
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped[0], "a".repeat(MEAT_SOFT_WRAP_WIDTH));
  assert.equal(wrapped[1], MEAT_SOFT_WRAP_CONTINUATION + "a".repeat(25));
});

test("softWrapReadingDiff wraps only overlong lines inside a multi-line diff", () => {
  const longBullet =
    "+| **Meat** | `/meat` command plus `meat_annotate` that opens the reading diff in Plannotator " +
    "browser UI via the shared event API and returns the user's verdict and annotations to the agent |";
  assert.ok(longBullet.length > MEAT_SOFT_WRAP_WIDTH);
  const raw = ["# summary", "diff --git a/README.md b/README.md", longBullet, " short"].join("\n");
  const out = softWrapReadingDiff(raw);
  const lines = out.split("\n");
  assert.equal(lines[0], "# summary");
  assert.equal(lines[1], "diff --git a/README.md b/README.md");
  assert.ok(lines[2]!.startsWith("+| **Meat**"));
  assert.ok(lines.some((l) => l.startsWith(MEAT_SOFT_WRAP_CONTINUATION)));
  assert.ok(lines.at(-1) === " short");
});

test("formatMeatReadingDiff soft-wraps long lines inside the fence", () => {
  const long =
    "+| **Meat** | " +
    "x".repeat(MEAT_SOFT_WRAP_WIDTH) +
    " trailing words that force a wrap past the column limit";
  const formatted = formatMeatReadingDiff(long);
  assert.match(formatted, /^```diff\n/);
  assert.ok(formatted.includes("\n" + MEAT_SOFT_WRAP_CONTINUATION));
  assert.ok(!formatted.split("\n").some((l) => l.length > MEAT_SOFT_WRAP_WIDTH && !l.startsWith("```")));
});

test("buildDocument wraps fenced meat content with title, source, repo", () => {
  const raw = ["# one-line summary", "", "diff --git a/a.ts b/a.ts", "+ok"].join("\n");
  const doc = buildDocument(raw, { title: "My review", source: "meat HEAD", repo: "pi-essentials" });
  assert.match(doc, /^# My review\n/);
  assert.match(doc, /\*\*Repo:\*\* `pi-essentials`/);
  assert.match(doc, /\*\*Source:\*\* `meat HEAD`/);
  assert.match(doc, /\*\*Reviewed:\*\* \d{4}-\d{2}-\d{2}T/);
  assert.match(doc, /```diff\n[\s\S]*one-line summary[\s\S]*\+ok[\s\S]*```/);
  assert.match(doc, /soft-wrap/);
  assert.match(buildDocument("plain notes", {}), /^# Meat reading diff\n/);
  assert.match(buildDocument("plain notes", {}), /```diff\nplain notes\n```/);
});

test("fenceCodeBlock lengthens backticks when the body contains fences", () => {
  assert.equal(fenceCodeBlock("hello", "diff"), "```diff\nhello\n```\n");
  assert.equal(fenceCodeBlock("has ``` inside", "diff"), "````diff\nhas ``` inside\n````\n");
});

test("parseCommandArgs handles /meat-annotate arguments", () => {
  assert.deepEqual(parseCommandArgs(""), {});
  assert.deepEqual(parseCommandArgs("HEAD~3"), { revision: "HEAD~3" });
  assert.deepEqual(parseCommandArgs("main...HEAD"), { revision: "main...HEAD" });
  assert.deepEqual(parseCommandArgs("-staged"), { staged: true });
  assert.deepEqual(parseCommandArgs("-w"), { working: true });
  // positional is dropped when -staged/-w is present
  assert.deepEqual(parseCommandArgs("-staged HEAD~1"), { staged: true });
  assert.deepEqual(parseCommandArgs("  -w  "), { working: true });
  assert.deepEqual(parseCommandArgs("-no-cache"), { noCache: true });
  assert.deepEqual(parseCommandArgs("-no-cache -staged"), { noCache: true, staged: true });
  assert.deepEqual(parseCommandArgs("HEAD~1 -no-cache"), { revision: "HEAD~1", noCache: true });
});

test("classifyAnnotationResult recognizes Plannotator verdicts", () => {
  assert.equal(classifyAnnotationResult({ feedback: "" }), "unclear");
  assert.equal(classifyAnnotationResult({ feedback: "", approved: true }), "approved");
  assert.equal(classifyAnnotationResult({ feedback: "note: add a test", approved: true }), "approved-with-notes");
  assert.equal(classifyAnnotationResult({ feedback: "1. the summary mischaracterizes the fallback" }), "annotations-requested");
  assert.equal(classifyAnnotationResult({ feedback: "", exit: true }), "closed");
  assert.equal(classifyAnnotationResult({ feedback: "comment", exit: true }), "closed");
});

test("requestAnnotation emits the annotate request and resolves on handled", async () => {
  const { emit, captured } = makeEmitter();
  const promise = requestAnnotation(emit, "/tmp/x.md", "# doc", true);
  const req = captured()!;
  assert.equal(req.channel, "plannotator:request");
  assert.equal(req.data.action, "annotate");
  assert.deepEqual(req.data.payload, { filePath: "/tmp/x.md", markdown: "# doc", gate: true });
  assert.ok(req.data.requestId);

  req.data.respond({ status: "handled", result: { feedback: "looks good", approved: true } });
  assert.deepEqual(await promise, { feedback: "looks good", approved: true });
});

test("requestAnnotation rejects on unavailable and error responses", async () => {
  const { emit, captured } = makeEmitter();
  const p1 = requestAnnotation(emit, "/tmp/x.md", "x", true);
  captured()!.data.respond({ status: "unavailable", error: "not installed" });
  await assert.rejects(p1, /Plannotator unavailable/);

  const p2 = requestAnnotation(emit, "/tmp/x.md", "x", true);
  captured()!.data.respond({ status: "error", error: "browser html missing" });
  await assert.rejects(p2, /Plannotator annotate failed: browser html missing/);
});

test("requestAnnotation defaults to gate on", async () => {
  const { emit, captured } = makeEmitter();
  requestAnnotation(emit, "/tmp/x.md", "x");
  assert.equal(captured()!.data.payload.gate, true);
});

test("requestAnnotation aborts when signal fires before respond", async () => {
  const { emit } = makeEmitter();
  const ac = new AbortController();
  const promise = requestAnnotation(emit, "/tmp/x.md", "x", true, { signal: ac.signal });
  ac.abort();
  await assert.rejects(promise, /Plannotator review aborted/);
});

test("requestAnnotation times out if Plannotator never responds", async () => {
  const { emit } = makeEmitter();
  const promise = requestAnnotation(emit, "/tmp/x.md", "x", true, { timeoutMs: 30 });
  await assert.rejects(promise, /Plannotator review timed out/);
});

test("raceHangGuards cancels timeout so a late timer does not reject unhandled", async () => {
  const result = await raceHangGuards(Promise.resolve("ok"), { timeoutMs: 50, label: "test" });
  assert.equal(result, "ok");
  // Give the cancelled timer a chance to misbehave if cancel failed.
  await new Promise((r) => setTimeout(r, 80));
});

test("isPlannotatorAvailable resolves true when a listener responds", async () => {
  const { emit, captured } = makeEmitter();
  const promise = isPlannotatorAvailable(emit, 2000);
  assert.equal(captured()!.data.action, "plan-mode");
  captured()!.data.respond({ status: "handled", result: { phase: "idle" } });
  assert.equal(await promise, true);
});

test("isPlannotatorAvailable resolves false when no listener is present", async () => {
  const { emit } = makeEmitter();
  assert.equal(await isPlannotatorAvailable(emit, 30), false);
});
