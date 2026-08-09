/**
 * Meat — one extension for the meat reading-diff abridger and its review flows.
 *
 * meat (github.com/boldsoftware/meat, installed as `meat`) abridges a diff into
 * a "reading diff": the few hunks a human actually needs to read. Plannotator
 * (github.com/backnotprop/plannotator) is a local browser UI for annotating
 * plans, markdown, and diffs, with an official pi extension
 * (`pi install npm:@plannotator/pi-extension`).
 *
 * This extension bundles:
 *   /meat [meat args]          Run meat, save the full output to .meat/latest.diff,
 *                              and inject the abridged diff into the conversation.
 *   meat_annotate (tool)       Run meat, open the reading diff in the Plannotator
 *                              browser UI (Approve / Annotate / Close gate), block
 *                              until the user decides, return verdict + feedback.
 *   /meat-annotate [args]      Same as meat_annotate, driven from the prompt.
 *
 * The annotate flows talk to Plannotator over the shared `plannotator:request`
 * event-bus channel of @plannotator/pi-extension.
 *
 * Environment:
 *   MEAT_BIN                    Path to the meat binary (default: `meat` on PATH).
 *   MEAT_ANNOTATE_TIMEOUT_MS    Timeout for the meat phase (default 20 min).
 *   MEAT_ANNOTATE_UI_TIMEOUT_MS Timeout waiting on Plannotator (default 30 min).
 *                               Without this, a browser session that never calls
 *                               back leaves the tool (and the agent turn) hung —
 *                               Escape/abort also cannot unblock it.
 */
import type { ExtensionAPI, AgentToolResult, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type ToolResult = AgentToolResult<{ verdict: string; file: string }>;
function ok(text: string, details: { verdict: string; file: string }): ToolResult {
  return { content: [{ type: "text", text }], details };
}

const DEFAULT_MEAT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_UI_TIMEOUT_MS = 30 * 60 * 1000;

function meatTimeoutMs(): number {
  return Number(process.env.MEAT_ANNOTATE_TIMEOUT_MS || DEFAULT_MEAT_TIMEOUT_MS);
}

function uiTimeoutMs(): number {
  return Number(process.env.MEAT_ANNOTATE_UI_TIMEOUT_MS || DEFAULT_UI_TIMEOUT_MS);
}

/** Reject when `signal` aborts. Resolves never; call the returned cancel to detach. */
export function abortPromise(
  signal: AbortSignal,
  label: string,
): { promise: Promise<never>; cancel: () => void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error(`${label} aborted`));
      return;
    }
    onAbort = () => reject(new Error(`${label} aborted`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Reject after `ms`. Call cancel() to clear the timer if the race already settled. */
export function timeoutPromise(
  ms: number,
  label: string,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 60000)} min`)),
      ms,
    );
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Race `work` against abort + optional timeout so a hung Plannotator cannot pin the agent turn. */
export async function raceHangGuards<T>(
  work: Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs?: number; label: string },
): Promise<T> {
  const cancels: Array<() => void> = [];
  const guards: Promise<T>[] = [work];
  if (opts.signal) {
    const a = abortPromise(opts.signal, opts.label);
    cancels.push(a.cancel);
    guards.push(a.promise);
  }
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const t = timeoutPromise(opts.timeoutMs, opts.label);
    cancels.push(t.cancel);
    guards.push(t.promise);
  }
  try {
    return await Promise.race(guards);
  } finally {
    for (const c of cancels) c();
    // If timeout/abort won, a late Plannotator respond must not become an unhandled rejection.
    void work.then(
      () => {},
      () => {},
    );
  }
}

/* ---- Plannotator shared event API (structural types; no import needed) ---- */

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";

export interface PlannotatorAnnotationResult {
  feedback: string;
  /** True when the reviewer closed the session without providing feedback. */
  exit?: boolean;
  /** True when the reviewer clicked Approve in review-gate mode. */
  approved?: boolean;
}

type PlannotatorResponse<T> =
  | { status: "handled"; result: T }
  | { status: "unavailable"; error?: string }
  | { status: "error"; error: string };

type EventEmitter = (channel: string, data: unknown) => void;

/** Ask Plannotator to open a markdown file in the annotation UI and wait for the decision. */
export function requestAnnotation(
  emit: EventEmitter,
  filePath: string,
  markdown: string,
  gate = true,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<PlannotatorAnnotationResult> {
  const work = new Promise<PlannotatorAnnotationResult>((resolve, reject) => {
    emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId: crypto.randomUUID(),
      action: "annotate",
      payload: { filePath, markdown, gate },
      respond: (response: PlannotatorResponse<PlannotatorAnnotationResult>) => {
        if (response.status === "handled") resolve(response.result);
        else if (response.status === "unavailable")
          reject(new Error(`Plannotator unavailable: ${response.error || "no error detail"}`));
        else reject(new Error(`Plannotator annotate failed: ${response.error}`));
      },
    });
  });
  return raceHangGuards(work, {
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
    label: "Plannotator review",
  });
}

/** Probe whether the Plannotator pi extension is listening on the shared channel. */
export function isPlannotatorAvailable(emit: EventEmitter, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve(false);
    }, timeoutMs);
    emit(PLANNOTATOR_REQUEST_CHANNEL, {
      requestId: crypto.randomUUID(),
      action: "plan-mode",
      payload: { mode: "status" },
      respond: () => {
        clearTimeout(timer);
        resolve(true);
      },
    });
  });
}

/* ---- Meat params and document building ---- */

export interface MeatAnnotateParams {
  revision?: string;
  staged?: boolean;
  working?: boolean;
  content?: string;
  title?: string;
  /** Pass meat `-no-cache` so an unchanged HEAD/diff is recomputed instead of served from ~/.meat. */
  noCache?: boolean;
}

/** Map tool/command params to meat CLI args. Staged wins over working. Empty args → meat's HEAD default. */
export function meatArgs(p: MeatAnnotateParams): string[] {
  const args: string[] = [];
  if (p.noCache) args.push("-no-cache");
  if (p.staged) args.push("-staged");
  else if (p.working) args.push("-w");
  const rev = p.revision?.trim();
  if (rev) args.push(rev);
  return args;
}

/** Human-readable source label for logs / the review doc. */
export function meatSourceLabel(p: MeatAnnotateParams): string {
  const args = meatArgs(p);
  return args.length ? `meat ${args.join(" ")}` : "meat (HEAD)";
}

export interface MeatFileSection {
  path: string;
  body: string;
}

export interface FormattedMeatReading {
  /** Meat's `# …` summary lines, with the leading `#` stripped. */
  summaryLines: string[];
  /** Per-file hunks split on `diff --git`. Empty when content isn't a meat/git diff. */
  files: MeatFileSection[];
  /** Raw leftover body when no `diff --git` sections were found. */
  fallbackBody?: string;
}

/**
 * Split meat's reading-diff into summary + per-file hunks.
 * Meat prefixes kept added lines with `+|` and emits `#` summary lines that
 * Plannotator's markdown UI would otherwise promote into real headings.
 */
export function parseMeatReadingDiff(content: string): FormattedMeatReading {
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return { summaryLines: [], files: [], fallbackBody: "" };

  const lines = text.split("\n");
  const summaryLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("#")) {
      summaryLines.push(line.replace(/^#\s?/, "").trimEnd());
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    break;
  }

  const rest = lines.slice(i).join("\n").trim();
  if (!rest) return { summaryLines, files: [] };

  const parts = rest.split(/(?=^diff --git )/m).filter((p) => p.trim());
  const files: MeatFileSection[] = [];
  const leftovers: string[] = [];
  for (const part of parts) {
    const m = part.match(/^diff --git a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!m) {
      leftovers.push(part.trimEnd());
      continue;
    }
    const path = (m[2] || m[1] || "file").trim();
    files.push({ path, body: part.trimEnd() });
  }

  if (files.length === 0) {
    return { summaryLines, files: [], fallbackBody: rest };
  }
  return {
    summaryLines,
    files,
    fallbackBody: leftovers.length ? leftovers.join("\n\n").trimEnd() : undefined,
  };
}

/**
 * Fence a body as a markdown code block. Lengthens the backtick run if the
 * body itself contains ``` so the fence cannot close early.
 */
export function fenceCodeBlock(body: string, lang = "diff"): string {
  const text = body.replace(/\r\n/g, "\n").trimEnd();
  if (!text) return `\`\`\`${lang}\n\n\`\`\`\n`;
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${text}\n${ticks}\n`;
}

/** Column width for soft-wrapping long lines inside the Plannotator fence. */
export const MEAT_SOFT_WRAP_WIDTH = 100;

/** Prefix for soft-wrap continuation lines — must not look like a diff marker. */
export const MEAT_SOFT_WRAP_CONTINUATION = "↳ ";

/**
 * Find a soft-break index in `text` at or before `budget`.
 * Prefers whitespace, then punctuation common in markdown/diffs; else hard-breaks.
 */
function findSoftBreak(text: string, budget: number): number {
  if (text.length <= budget) return text.length;
  const minBreak = Math.max(1, Math.floor(budget * 0.5));
  for (let i = budget; i >= minBreak; i--) {
    if (/\s/.test(text[i - 1]!)) return i;
  }
  for (let i = budget; i >= minBreak; i--) {
    const ch = text[i - 1]!;
    if (ch === "|" || ch === "/" || ch === "," || ch === ")" || ch === "]" || ch === "(" || ch === "[") {
      return i;
    }
  }
  return budget;
}

/**
 * Soft-wrap one logical line for display. Keeps a single semantic diff line;
 * inserts visual breaks with a continuation marker so Plannotator stays readable.
 */
export function softWrapLine(
  line: string,
  width = MEAT_SOFT_WRAP_WIDTH,
  continuation = MEAT_SOFT_WRAP_CONTINUATION,
): string[] {
  if (width < 8) width = 8;
  if (line.length <= width) return [line];

  const out: string[] = [];
  let remaining = line;
  let first = true;

  while (remaining.length > 0) {
    const budget = first ? width : Math.max(1, width - continuation.length);
    if (remaining.length <= budget) {
      out.push(first ? remaining : continuation + remaining);
      break;
    }

    const breakAt = findSoftBreak(remaining, budget);
    const raw = remaining.slice(0, breakAt);
    const piece = raw.replace(/\s+$/, "");
    if (piece.length === 0) {
      // Pathological: budget is all whitespace, or hard-break needed.
      const hard = remaining.slice(0, budget);
      out.push(first ? hard : continuation + hard);
      remaining = remaining.slice(budget);
    } else {
      out.push(first ? piece : continuation + piece);
      remaining = remaining.slice(breakAt).replace(/^\s+/, "");
    }
    first = false;
  }

  return out;
}

/** Soft-wrap every line of a reading diff (or arbitrary text) for the annotate fence. */
export function softWrapReadingDiff(
  content: string,
  width = MEAT_SOFT_WRAP_WIDTH,
): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => softWrapLine(line, width))
    .join("\n");
}

/**
 * Put the whole meat reading-diff in one code fence so Plannotator renders it
 * as monospace code (real newlines) instead of prose. Long lines are soft-wrapped
 * with a continuation marker so the browser UI stays readable without horizontal scroll.
 */
export function formatMeatReadingDiff(content: string): string {
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return fenceCodeBlock("(empty reading diff)", "diff");
  return fenceCodeBlock(softWrapReadingDiff(text), "diff");
}

/** Wrap the meat output (or arbitrary content) in a small review document. */
export function buildDocument(
  content: string,
  opts: { title?: string; source?: string; repo?: string },
): string {
  const title = opts.title?.trim() || "Meat reading diff";
  const lines: string[] = [`# ${title}`];
  if (opts.repo) lines.push(`**Repo:** \`${opts.repo}\``);
  if (opts.source) lines.push(`**Source:** \`${opts.source}\``);
  lines.push(`**Reviewed:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    "> Meat abridges the diff (keeps substantive lines). `+|` marks a kept added line. " +
      "The reading diff is one code block so Plannotator keeps real line breaks; " +
      `long lines soft-wrap at ${MEAT_SOFT_WRAP_WIDTH} cols with \`${MEAT_SOFT_WRAP_CONTINUATION.trim()}\` continuation.`,
  );
  lines.push("");
  lines.push(formatMeatReadingDiff(content).trimEnd());
  lines.push("");
  return lines.join("\n");
}

/** Parse `/meat-annotate` command args into tool params. */
export function parseCommandArgs(args: string): MeatAnnotateParams {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const params: MeatAnnotateParams = {};
  for (const t of tokens) {
    if (t === "-staged") params.staged = true;
    else if (t === "-w" || t === "--working") params.working = true;
    else if (t === "-no-cache" || t === "--no-cache") params.noCache = true;
    else if (!params.staged && !params.working && !params.revision) params.revision = t;
    // extra positionals are ignored when -staged/-w is present
  }
  return params;
}

/* ---- Verdict classification ---- */

export type Verdict = "approved" | "approved-with-notes" | "annotations-requested" | "closed" | "unclear";

/** Classify Plannotator's annotation result into a verdict. */
export function classifyAnnotationResult(r: PlannotatorAnnotationResult): Verdict {
  if (r.approved && r.feedback?.trim()) return "approved-with-notes";
  if (r.approved) return "approved";
  if (r.exit) return "closed";
  if (r.feedback?.trim()) return "annotations-requested";
  return "unclear";
}

const VERDICT_LINES: Record<Verdict, string> = {
  approved: "The user approved the reading diff.",
  "approved-with-notes": "The user approved, with notes below — incorporate them.",
  "annotations-requested": "The user requested changes — the feedback below is instructions, in document order.",
  closed: "The user closed the review without deciding — ask how they'd like to proceed.",
  unclear: "The review finished with an unrecognized result (output below).",
};

/* ---- Child process helper ---- */

interface CapturedRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing stdout/stderr with a size guard. Honors AbortSignal. */
function runCapture(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<CapturedRun> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error(`${bin} aborted`));
      return;
    }
    const child = spawn(bin, args, { cwd: opts.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout.on("data", (buf: Buffer) => {
      if (stdout.length + buf.length > maxBytes) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      settle(() => reject(new Error(`failed to run ${bin}: ${err.message}`)));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      settle(() => {
        if (opts.signal?.aborted) {
          reject(new Error(`${bin} aborted`));
          return;
        }
        if (killed) {
          reject(new Error(`${bin} output exceeded ${maxBytes} bytes; aborted.`));
          return;
        }
        resolvePromise({ code, signal, stdout, stderr });
      });
    });
  });
}

/* ---- Annotate flow (tool + command) ---- */

export interface AnnotateOutcome {
  verdict: Verdict;
  feedback: string;
  approved?: boolean;
  exit?: boolean;
  file: string;
  source?: string;
}

/** Run meat (or use provided content), then block on Plannotator until the user decides. */
export async function runMeatAnnotate(
  pi: { events: { emit: EventEmitter } },
  p: MeatAnnotateParams,
  opts: { cwd: string; onUpdate?: (text: string) => void; signal?: AbortSignal },
): Promise<AnnotateOutcome> {
  let content = p.content?.trim();
  let source: string | undefined;

  if (!content) {
    const bin = process.env.MEAT_BIN?.trim() || "meat";
    const args = meatArgs(p);
    source = meatSourceLabel(p);
    const reviewingHead = !p.staged && !p.working && !p.revision?.trim();
    const cacheNote = p.noCache
      ? "(-no-cache: forcing recompute)"
      : "(meat caches identical diffs under ~/.meat; pass noCache / -no-cache to force a fresh run)";
    opts.onUpdate?.(
      `Running \`${source}\`${reviewingHead ? " — default is the latest commit (HEAD), not working-tree WIP" : ""}… ${cacheNote}`,
    );
    const timeoutMs = meatTimeoutMs();
    const res = await runCapture(bin, args, { cwd: opts.cwd, timeoutMs, signal: opts.signal });
    if (res.code !== 0) {
      const why =
        opts.signal?.aborted
          ? "meat aborted"
          : res.signal === "SIGKILL"
            ? `meat timed out after ${Math.round(timeoutMs / 60000)} min`
            : `meat exited with code ${res.code}`;
      const detail = res.stderr.trim() || res.stdout.trim();
      throw new Error(
        `${why}.\n${detail ? `${detail}\n` : ""}Is meat installed? go install meat.dev/cmd/meat@latest (or set MEAT_BIN).`,
      );
    }
    content = res.stdout.trim();
    if (!content) throw new Error("meat produced no output — nothing to annotate.");
  }

  if (!(await isPlannotatorAvailable(pi.events.emit))) {
    throw new Error(
      "Plannotator pi extension not detected. Install it: pi install npm:@plannotator/pi-extension",
    );
  }

  const doc = buildDocument(content, {
    title: p.title,
    source,
    repo: basename(opts.cwd),
  });
  const file = join(
    tmpdir(),
    `meat-annotate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  writeFileSync(file, doc, "utf8");

  const uiMs = uiTimeoutMs();
  opts.onUpdate?.(
    `Opening the reading diff in Plannotator — waiting for Approve / Annotate / Close in the browser ` +
      `(timeout ${Math.round(uiMs / 60000)} min; Escape/abort cancels)…`,
  );
  const result = await requestAnnotation(pi.events.emit, file, doc, true, {
    signal: opts.signal,
    timeoutMs: uiMs,
  });
  return {
    verdict: classifyAnnotationResult(result),
    feedback: result.feedback,
    approved: result.approved,
    exit: result.exit,
    file,
    source,
  };
}

function formatOutcome(r: AnnotateOutcome, cwd: string): string {
  return [
    "meat reading diff reviewed in Plannotator.",
    "",
    `Source: ${r.source || "inline content"}`,
    `Repo: ${basename(cwd)}`,
    `Document: ${r.file}`,
    `Verdict: ${r.verdict}`,
    "",
    VERDICT_LINES[r.verdict],
    "",
    r.feedback.trim() || "(no feedback)",
    "",
  ].join("\n");
}

/* ---- /meat command (port of the standalone local extension) ---- */

// Cap what gets injected into the LLM conversation. The full output is always
// written to .meat/latest.diff, so nothing is lost for annotation workflows.
const MAX_INJECTED_BYTES = 60 * 1024;

async function runMeatCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const cwd = ctx.cwd || process.cwd();
  const argv = args.trim().split(/\s+/).filter(Boolean);

  ctx.ui.notify(`meat: running (${argv.length ? argv.join(" ") : "HEAD"})…`, "info");

  const timeoutMs = meatTimeoutMs();
  const bin = process.env.MEAT_BIN?.trim() || "meat";
  const { stdout, stderr, code } = await runCapture(bin, argv, { cwd, timeoutMs });

  if (code !== 0) {
    const errText = (stderr.trim() || stdout.trim() || `meat exited with code ${code}`).slice(0, 2000);
    ctx.ui.notify(`meat failed: ${errText}`, "error");
    return;
  }

  // Persist the full reading diff for plannotator / file-based review.
  const outPath = join(resolve(cwd), ".meat", "latest.diff");
  await mkdir(resolve(cwd, ".meat"), { recursive: true });
  await writeFile(outPath, stdout, "utf8");

  // Surface the token/elapsed line meat prints to stderr, if present.
  const statsLine = (stderr.match(/meat: tokens in=\d+ out=\d+ in [^\n]*/) || [""])[0];
  const summary = stdout.split("\n")[0] || "";
  const body =
    stdout.length > MAX_INJECTED_BYTES
      ? stdout.slice(0, MAX_INJECTED_BYTES) + `\n\n… [truncated for context; full output saved to ${outPath}]`
      : stdout;

  const header = [
    "**meat (reading diff)** — " +
      (argv.length ? `\`meat ${argv.join(" ")}\`` : "HEAD") +
      (summary ? ` — ${summary}` : ""),
    statsLine ? `_${statsLine}_` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await pi.sendUserMessage(`${header}\n\n\`\`\`diff\n${body}\n\`\`\``, { deliverAs: "steer" });
  ctx.ui.notify(`meat done — saved to ${outPath}`, "info");
}

export default function meat(pi: ExtensionAPI) {
  pi.registerTool({
    name: "meat_annotate",
    label: "Annotate reading diff",
    description:
      "Run `meat` to abridge a git diff into a reading diff, then open it in the Plannotator browser UI " +
      "(Approve / Annotate / Close gate) for the user to review and annotate. " +
      "Blocks until the user decides; returns the verdict and any feedback as instructions to act on. " +
      "Use when the user wants to review the important parts of a diff (a commit, a range, staged or working changes) " +
      "in the browser before proceeding — e.g. reviewing agent-written code, or a change the user wants to sign off on.",
    promptSnippet: "Review a diff's meat in the browser: meat_annotate",
    promptGuidelines: [
      "Use meat_annotate when the user wants to review the substantive parts of a diff in the browser before proceeding. It runs `meat`, opens the reading diff in Plannotator's annotation UI, and blocks until the user approves, annotates, or closes.",
      "Pass through the user's git-like selection: a revision (sha, HEAD~3), a range (sha1..sha2, main...HEAD), staged: true for the index, or working: true for the working tree. Default is the latest commit (HEAD) — not unstaged WIP; use working/staged for that.",
      "Meat caches identical diffs under ~/.meat, so re-reviewing the same HEAD returns instantly with the same reading diff. Pass noCache: true (or -no-cache) to force a fresh LLM run.",
      "To annotate text you already have (an existing reading diff, a plan, a spec), pass it as `content` and skip meat entirely.",
      "Treat the returned feedback as instructions from the user, in document order; suggested edits include replacement text — apply it verbatim unless it conflicts, then say so.",
    ],
    parameters: Type.Object({
      revision: Type.Optional(
        Type.String({
          description:
            "Commit or revision to abridge: a sha, HEAD~3, or a range like sha1..sha2 / main...HEAD. Defaults to HEAD (the latest commit).",
        }),
      ),
      staged: Type.Optional(
        Type.Boolean({
          description: "Abridge the staged (index) changes instead of a commit (meat -staged). Mutually exclusive with working.",
        }),
      ),
      working: Type.Optional(
        Type.Boolean({
          description: "Abridge the unstaged working-tree changes (meat -w). Mutually exclusive with staged.",
        }),
      ),
      content: Type.Optional(
        Type.String({
          description: "Skip meat and annotate this text directly — e.g. an existing reading diff, a plan, or a spec.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Title for the review document (default: 'Reading diff')." }),
      ),
      noCache: Type.Optional(
        Type.Boolean({
          description: "Pass -no-cache to meat so an unchanged diff is recomputed instead of served from ~/.meat.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const updater = onUpdate
        ? (text: string) => onUpdate({ content: [{ type: "text", text }], details: { verdict: "running", file: "" } })
        : undefined;
      const r = await runMeatAnnotate(pi, params, { cwd: ctx.cwd, onUpdate: updater, signal });
      return ok(formatOutcome(r, ctx.cwd), { verdict: r.verdict, file: r.file });
    },
  });

  pi.registerCommand("meat", {
    description:
      "Run meat (reading-diff abridger) on the current repo; args pass through to the meat CLI, e.g. /meat HEAD~3, /meat -staged, /meat -w, /meat -no-cache, /meat -model opencode/claude-sonnet-4-6",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await runMeatCommand(pi, ctx, args);
    },
  });

  pi.registerCommand("meat-annotate", {
    description:
      "Abridge a diff with meat and review it in the Plannotator browser UI (usage: /meat-annotate [revision|range|-staged|-w|-no-cache])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const params = parseCommandArgs(args);
      const ac = new AbortController();
      // Command path has no tool AbortSignal — still enforce the UI timeout so a
      // dead browser session cannot pin the prompt forever.
      const timer = setTimeout(() => ac.abort(), uiTimeoutMs());
      try {
        const r = await runMeatAnnotate(pi, params, { cwd: ctx.cwd, signal: ac.signal });
        // Single-line notify — multiline notify can leave the TUI looking stuck.
        ctx.ui.notify(
          `${VERDICT_LINES[r.verdict]} (${r.file})`,
          r.verdict === "annotations-requested" ? "warning" : "info",
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
