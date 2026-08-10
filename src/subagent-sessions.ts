/**
 * Session durability helpers for background subagents.
 *
 * Extracted so unit tests can import pure logic without peer deps.
 * Background runs persist transcripts under SUBAGENT_SESSION_DIR; clean exits
 * delete their file, crashes survive for /resume-subagent recovery.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUBAGENT_SESSION_DIR = join(homedir(), ".pi", "agent", "subagent-sessions");

export function ensureSubagentSessionDir(): void {
  if (!existsSync(SUBAGENT_SESSION_DIR)) {
    mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
  }
}

export function stableSubagentSessionId(id: string): string {
  return `subagent-${id}-${randomBytes(4).toString("hex")}`;
}

export function deleteSubagentSessionFile(sessionId: string): void {
  try {
    for (const f of readdirSync(SUBAGENT_SESSION_DIR)) {
      if (f.endsWith(`_${sessionId}.jsonl`)) {
        unlinkSync(join(SUBAGENT_SESSION_DIR, f));
      }
    }
  } catch {}
}

export function listSubagentSessionFiles(): { file: string; mtime: number }[] {
  try {
    const out: { file: string; mtime: number }[] = [];
    for (const f of readdirSync(SUBAGENT_SESSION_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(SUBAGENT_SESSION_DIR, f);
      try { out.push({ file: full, mtime: statSync(full).mtimeMs }); } catch {}
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch {
    return [];
  }
}

export { relativeTime } from "./relative-time.js";
