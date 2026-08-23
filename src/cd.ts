/**
 * /cd — bash-style working directory switching.
 *
 * The system prompt keeps the launch directory (editing it would invalidate
 * the prompt cache every turn). Instead:
 *   1. bash is overridden with a spawnHook that redirects execution cwd per call
 *   2. a tool_call interceptor rewrites relative (and missing) paths for file
 *      tools so they resolve against the current dir
 *   3. a custom message (user-role in LLM context) tells the model about the
 *      change — appended, never rewritten, so the cached prefix survives
 */
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

export function expandHome(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  return target;
}

/** Resolve a /cd argument the way bash does. Bare → home. `-` → previous dir. */
export function resolveCdTarget(
  raw: string,
  current: string,
  prev: string | null,
): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === "-") {
    if (!prev) return { ok: false, reason: "cd: OLDPWD not set" };
    return { ok: true, path: prev };
  }
  const target = expandHome(trimmed || "~");
  return { ok: true, path: isAbsolute(target) ? target : resolve(current, target) };
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * New path for a file-tool `path` arg, or undefined if no rewrite is needed.
 * Missing path after a cd → current dir (ls/grep/find default to cwd).
 */
export function rewriteToolPath(
  path: string | undefined,
  current: string,
  launch: string,
): string | undefined {
  if (current === launch) return undefined;
  if (typeof path !== "string" || !path) return current;
  const p = path.replace(/^@/, "");
  if (isAbsolute(p)) return undefined;
  return resolve(current, p);
}

export function reminderText(dir: string): string {
  return `<system-reminder>Note: the user changed the session working directory to ${dir}. Shell commands and file tools now operate there. Relative paths mentioned earlier in this conversation may now resolve differently.</system-reminder>`;
}

/**
 * Directory completions for `/cd <prefix>`.
 * `value` replaces the whole argument (pi's TUI does that).
 * Trailing `/` on label keeps Tab walking into the folder.
 */
export function completeDirs(
  prefix: string,
  current: string,
): { value: string; label: string }[] {
  const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  const dirPart = slash === -1 ? "" : prefix.slice(0, slash + 1);
  const namePrefix = slash === -1 ? prefix : prefix.slice(slash + 1);
  const resolved = resolveCdTarget(dirPart || ".", current, null);
  if (!resolved.ok || !isDir(resolved.path)) return [];

  const showHidden = namePrefix.startsWith(".");
  const needle = namePrefix.toLowerCase();
  let entries;
  try {
    entries = readdirSync(resolved.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: { value: string; label: string }[] = [];
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    if (!showHidden && entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().startsWith(needle)) continue;
    let directory = entry.isDirectory();
    if (!directory && entry.isSymbolicLink()) {
      directory = isDir(resolve(resolved.path, entry.name));
    }
    if (!directory) continue;
    items.push({ value: `${dirPart}${entry.name}/`, label: `${entry.name}/` });
  }
  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

export default function (pi: ExtensionAPI) {
  const launchDir = process.cwd();
  let dir = launchDir;
  let prev: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "cd") {
        const data = entry.data as { dir?: string; prev?: string | null } | undefined;
        if (typeof data?.dir === "string") {
          dir = data.dir;
          prev = typeof data.prev === "string" ? data.prev : null;
        }
      }
    }
    if (!isDir(dir)) dir = launchDir;
  });

  pi.registerTool(
    createBashToolDefinition(launchDir, {
      spawnHook: (c) => ({ ...c, cwd: dir }),
    }),
  );

  pi.on("tool_call", (event) => {
    if (!PATH_TOOLS.has(event.toolName)) return;
    const input = event.input as { path?: string };
    const next = rewriteToolPath(input.path, dir, launchDir);
    if (next) input.path = next;
  });

  pi.registerCommand("cd", {
    description: "Change the session working directory",
    getArgumentCompletions: (prefix) => {
      const items = completeDirs(prefix, dir);
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const resolved = resolveCdTarget(args, dir, prev);
      if (!resolved.ok) {
        ctx.ui.notify(resolved.reason, "error");
        return;
      }
      if (!isDir(resolved.path)) {
        ctx.ui.notify(`cd: no such directory: ${resolved.path}`, "error");
        return;
      }
      prev = dir;
      dir = resolved.path;
      pi.appendEntry("cd", { dir, prev });
      pi.sendMessage(
        {
          customType: "cd",
          display: false,
          content: reminderText(dir),
        },
        { deliverAs: "nextTurn" },
      );
      ctx.ui.notify(`cwd → ${dir}`, "info");
    },
  });
}
