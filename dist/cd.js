// src/cd.ts
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
var PATH_TOOLS = /* @__PURE__ */ new Set(["read", "write", "edit", "grep", "find", "ls"]);
function expandHome(target) {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  return target;
}
function resolveCdTarget(raw, current, prev) {
  const trimmed = raw.trim();
  if (trimmed === "-") {
    if (!prev) return { ok: false, reason: "cd: OLDPWD not set" };
    return { ok: true, path: prev };
  }
  const target = expandHome(trimmed || "~");
  return { ok: true, path: isAbsolute(target) ? target : resolve(current, target) };
}
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function rewriteToolPath(path, current, launch) {
  if (current === launch) return void 0;
  if (typeof path !== "string" || !path) return current;
  const p = path.replace(/^@/, "");
  if (isAbsolute(p)) return void 0;
  return resolve(current, p);
}
function reminderText(dir) {
  return `<system-reminder>Note: the user changed the session working directory to ${dir}. Shell commands and file tools now operate there. Relative paths mentioned earlier in this conversation may now resolve differently.</system-reminder>`;
}
function completeDirs(prefix, current) {
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
  const items = [];
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
function cd_default(pi) {
  const launchDir = process.cwd();
  let dir = launchDir;
  let prev = null;
  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "cd") {
        const data = entry.data;
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
      spawnHook: (c) => ({ ...c, cwd: dir })
    })
  );
  pi.on("tool_call", (event) => {
    if (!PATH_TOOLS.has(event.toolName)) return;
    const input = event.input;
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
          content: reminderText(dir)
        },
        { deliverAs: "nextTurn" }
      );
      ctx.ui.notify(`cwd \u2192 ${dir}`, "info");
    }
  });
}
export {
  completeDirs,
  cd_default as default,
  expandHome,
  isDir,
  reminderText,
  resolveCdTarget,
  rewriteToolPath
};
//# sourceMappingURL=cd.js.map
