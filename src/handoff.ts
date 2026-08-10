/**
 * handoff — session handoff documents for topic-to-topic work.
 *
 * At the end of a work session, `/handoff <topic>` gathers the session's
 * mechanical state (branch, working tree, diff stat, recent commits, session
 * file path) and asks the agent to write a handoff doc to
 * `handoff/handoff-<topic>.md` using a fixed template. At the start of the
 * next session, `/handoff` (no args) lists the docs, picks one, and injects
 * it as the first user message — the agent starts with full context without
 * any manual "read the handoff doc" instruction.
 *
 * Commands:
 *   /handoff <topic>   write a handoff doc for this session
 *   /handoff [resume]  pick a handoff doc and inject it into this session
 *   /handoff list      list saved handoff docs
 *   /handoff delete    delete a handoff doc
 *
 * A one-line hint is shown at session start (startup / new) when handoff
 * docs exist in the project. Docs live in `handoff/` (gitignored) by
 * default; PI_HANDOFF_DIR overrides the directory. Resuming a doc marks it
 * consumed — the hint stops showing it until the doc is updated again
 * (state in `handoff/.handoff-state.json`).
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { relativeTime } from "./relative-time.js";
import { summarizeTitle } from "./title-summary.js";

// ── Pure helpers (unit-testable, no peer deps) ─────────────────────────

export function handoffDir(cwd: string): string {
  const raw = process.env.PI_HANDOFF_DIR;
  return raw ? raw : join(cwd, "handoff");
}

export function handoffSlug(topic: string): string {
  return summarizeTitle(topic) || "untitled";
}

export function handoffPath(cwd: string, topic: string): string {
  return join(handoffDir(cwd), `handoff-${handoffSlug(topic)}.md`);
}

export function listHandoffDocs(dir: string): { file: string; mtime: number }[] {
  try {
    const out: { file: string; mtime: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      try { out.push({ file: full, mtime: statSync(full).mtimeMs }); } catch {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch {
    return [];
  }
}

// ── Consumed-state tracking ────────────────────────────────────────────

const STATE_FILE = ".handoff-state.json";

export interface HandoffState {
  /** doc basename → epoch ms of the last resume that consumed it */
  consumed: Record<string, number>;
}

export function statePath(dir: string): string {
  return join(dir, STATE_FILE);
}

export function readState(dir: string): HandoffState {
  try {
    const raw = JSON.parse(readFileSync(statePath(dir), "utf8")) as Partial<HandoffState>;
    // Prune entries for docs that no longer exist on disk.
    const existing = new Set(readdirSync(dir));
    const consumed: Record<string, number> = {};
    for (const [name, at] of Object.entries(raw.consumed ?? {})) {
      if (typeof at === "number" && existing.has(name)) consumed[name] = at;
    }
    return { consumed };
  } catch {
    return { consumed: {} };
  }
}

export function writeState(dir: string, state: HandoffState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch { /* state is best-effort */ }
}

export function markConsumed(dir: string, doc: string): void {
  const state = readState(dir);
  state.consumed[doc] = Date.now();
  writeState(dir, state);
}

/**
 * A doc is consumed when it was resumed after its last write. If it was
 * modified after the resume (an in-place update via /handoff), it is a
 * fresh handoff and should be surfaced again.
 */
export function isHandoffConsumed(state: HandoffState, file: string, mtime: number): boolean {
  const at = state.consumed[basename(file)];
  return at !== undefined && at >= mtime;
}

export function unreadHandoffDocs(
  state: HandoffState,
  docs: { file: string; mtime: number }[],
): { file: string; mtime: number }[] {
  return docs.filter((d) => !isHandoffConsumed(state, d.file, d.mtime));
}

// ── Git state ──────────────────────────────────────────────────────────

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export interface GitState {
  branch?: string;
  status?: string;
  diffStat?: string;
  commits?: string;
}

export function gitState(cwd: string): GitState {
  return {
    branch: runGit(cwd, ["branch", "--show-current"]) ?? runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: runGit(cwd, ["status", "--short"]),
    diffStat: runGit(cwd, ["diff", "--stat"]),
    commits: runGit(cwd, ["log", "--oneline", "-8"]),
  };
}

function capLines(text: string, indent: string, cap: number): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const shown = lines.slice(0, cap);
  const out = shown.map((l) => `${indent}${l}`).join("\n");
  if (lines.length > cap) return `${out}\n${indent}… (+${lines.length - cap} more)`;
  return out;
}

export function renderGitState(s: GitState): string {
  return [
    `- Branch: ${s.branch ?? "(not a git repo)"}`,
    `- Working tree:\n${capLines(s.status ?? "(clean)", "  ", 40)}`,
    `- Diff stat:\n${capLines(s.diffStat ?? "(no uncommitted diff)", "  ", 40)}`,
    `- Recent commits:\n${capLines(s.commits ?? "(none)", "  ", 8)}`,
  ].join("\n");
}

function sessionStateBlock(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile() ?? "(ephemeral)";
  const name = pi.getSessionName() ?? basename(sessionFile);
  return [
    `- Session: ${name}`,
    `- Session file: ${sessionFile}`,
    `- Saved: ${new Date().toISOString()}`,
    ...renderGitState(gitState(ctx.cwd)).split("\n"),
  ].join("\n");
}

// ── Write side ─────────────────────────────────────────────────────────

function writePrompt(path: string, topic: string, state: string): string {
  return `Write a session handoff document and save it to:
${path}

Topic: ${topic}

Follow this structure (same shape as the existing handoff docs in this project):

# Handoff — ${topic}

## Mission
What this session is working toward, in 2-4 sentences.

## Hard rules
Constraints the next session must respect (e.g. no commits without review, behavior-preserving only). Omit if none.

## State
Start with the mechanical state block below (keep it verbatim), then add anything only this session knows: uncommitted files that matter, half-finished work, decisions made and why.

${state}

## Next steps
Concrete next actions, in order. If work is unfinished, say exactly what is left.

## Acceptance criteria
A checklist the next session can tick off. Omit if not applicable.

Rules: write for a fresh session with zero memory. Be specific — file paths, commit shas, branch names. No fluff. If the file already exists, update it in place. The session file path in the state block points at the full transcript; the next session can read it for detail.`;
}

function writeHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext, topic: string): void {
  const path = handoffPath(ctx.cwd, topic);
  const state = sessionStateBlock(pi, ctx);
  pi.sendUserMessage(writePrompt(path, topic, state), { deliverAs: "steer" });
  ctx.ui.notify(`Writing handoff to ${path} — see the agent's response.`, "info");
}

// ── Read side ──────────────────────────────────────────────────────────

function docOptions(docs: { file: string; mtime: number }[]): string[] {
  return docs.map((f) => `${basename(f.file)}  (${relativeTime(f.mtime)})`);
}

async function resumeHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const docs = listHandoffDocs(handoffDir(ctx.cwd));
  if (docs.length === 0) {
    ctx.ui.notify("No handoff docs found. Run /handoff <topic> at the end of a session to write one.", "info");
    return;
  }
  const options = docOptions(docs);
  const choice = await ctx.ui.select("Resume a handoff:", options);
  if (!choice) return;
  const selected = docs[options.indexOf(choice)];
  let content: string;
  try {
    content = readFileSync(selected.file, "utf8");
  } catch {
    ctx.ui.notify(`Could not read ${basename(selected.file)}.`, "error");
    return;
  }
  const framed =
    `Continuing work from a previous session. Handoff doc "${basename(selected.file)}" (saved ${relativeTime(selected.mtime)}):\n\n` +
    content +
    `\n\nStart by orienting yourself — read the referenced session file if you need more detail than this doc — then continue the work.`;
  pi.sendUserMessage(framed, { deliverAs: "steer" });
  markConsumed(handoffDir(ctx.cwd), basename(selected.file));
  ctx.ui.notify(`Resumed handoff ${basename(selected.file)} — the agent now has full context.`, "info");
}

function listHandoffs(ctx: ExtensionCommandContext): void {
  const dir = handoffDir(ctx.cwd);
  const docs = listHandoffDocs(dir);
  if (docs.length === 0) {
    ctx.ui.notify(`No handoff docs in ${dir}. Run /handoff <topic> at the end of a session to write one.`, "info");
    return;
  }
  ctx.ui.notify(`Handoff docs:\n${docOptions(docs).map((o) => `- ${o}`).join("\n")}`, "info");
}

async function deleteHandoff(ctx: ExtensionCommandContext): Promise<void> {
  const docs = listHandoffDocs(handoffDir(ctx.cwd));
  if (docs.length === 0) {
    ctx.ui.notify("No handoff docs to delete.", "info");
    return;
  }
  const options = docOptions(docs);
  const choice = await ctx.ui.select("Delete which handoff?", options);
  if (!choice) return;
  const selected = docs[options.indexOf(choice)];
  const ok = await ctx.ui.confirm("Delete handoff?", `${basename(selected.file)} will be permanently removed.`);
  if (!ok) return;
  try {
    unlinkSync(selected.file);
    ctx.ui.notify(`Deleted ${basename(selected.file)}.`, "info");
  } catch {
    ctx.ui.notify("Delete failed.", "error");
  }
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description:
      "Session handoff docs. /handoff <topic> writes one for this session; /handoff [resume] picks one and injects it; /handoff list; /handoff delete.",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.split(/\s+/);
      const first = parts[0] ?? "";
      if (parts.length === 1) {
        const items = ["resume", "list", "delete"]
          .filter((s) => s.startsWith(first))
          .map((s) => ({ value: s, label: s }));
        return items.length ? items : null;
      }
      if (first === "resume" || first === "delete") {
        const doc = parts.slice(1).join(" ");
        const docs = listHandoffDocs(handoffDir(process.cwd()));
        const items = docs
          .filter((f) => basename(f.file).startsWith(doc))
          .map((f) => ({ value: basename(f.file), label: basename(f.file) }));
        return items.length ? items : null;
      }
      return null;
    },
    handler: async (args, ctx) => {
      const arg = (args || "").trim();
      if (arg === "list") listHandoffs(ctx);
      else if (arg === "delete") await deleteHandoff(ctx);
      else if (arg === "resume" || arg === "") await resumeHandoff(pi, ctx);
      else writeHandoff(pi, ctx, arg);
    },
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    const dir = handoffDir(ctx.cwd);
    const docs = listHandoffDocs(dir);
    if (docs.length === 0) return;
    const unread = unreadHandoffDocs(readState(dir), docs);
    if (unread.length === 0) return;
    const newest = unread[0];
    const more = unread.length > 1 ? ` (+${unread.length - 1} more)` : "";
    ctx.ui.notify(
      `Handoff available: ${basename(newest.file)} (${relativeTime(newest.mtime)})${more} — run /handoff to resume`,
      "info",
    );
  });
}
