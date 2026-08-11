// src/files.ts
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  SelectList,
  Spacer,
  Text
} from "@earendil-works/pi-tui";
var FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
var FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
var PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;
var MAX_EDIT_BYTES = 40 * 1024 * 1024;
var extractFileReferencesFromText = (text) => {
  const refs = [];
  for (const match of text.matchAll(FILE_TAG_REGEX)) {
    refs.push(match[1]);
  }
  for (const match of text.matchAll(FILE_URL_REGEX)) {
    refs.push(match[0]);
  }
  for (const match of text.matchAll(PATH_REGEX)) {
    refs.push(match[1]);
  }
  return refs;
};
var extractPathsFromToolArgs = (args) => {
  if (!args || typeof args !== "object") {
    return [];
  }
  const refs = [];
  const record = args;
  const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"];
  const listKeys = ["paths", "files", "filePaths"];
  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === "string") {
      refs.push(value);
    }
  }
  for (const key of listKeys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          refs.push(item);
        }
      }
    }
  }
  return refs;
};
var extractFileReferencesFromContent = (content) => {
  if (typeof content === "string") {
    return extractFileReferencesFromText(content);
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const refs = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const block = part;
    if (block.type === "text" && typeof block.text === "string") {
      refs.push(...extractFileReferencesFromText(block.text));
    }
    if (block.type === "toolCall") {
      refs.push(...extractPathsFromToolArgs(block.arguments));
    }
  }
  return refs;
};
var extractFileReferencesFromEntry = (entry) => {
  if (entry.type === "message") {
    return "content" in entry.message ? extractFileReferencesFromContent(entry.message.content) : [];
  }
  if (entry.type === "custom_message") {
    return extractFileReferencesFromContent(entry.content);
  }
  return [];
};
var sanitizeReference = (raw) => {
  let value = raw.trim();
  value = value.replace(/^["'`(<\[]+/, "");
  value = value.replace(/[>"'`,;).\]]+$/, "");
  value = value.replace(/[.,;:]+$/, "");
  return value;
};
var isCommentLikeReference = (value) => value.startsWith("//");
var stripLineSuffix = (value) => {
  let result = value.replace(/#L\d+(C\d+)?$/i, "");
  const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
  const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
  const segment = result.slice(segmentStart);
  const colonIndex = segment.indexOf(":");
  if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
    result = result.slice(0, segmentStart + colonIndex);
    return result;
  }
  const lastColon = result.lastIndexOf(":");
  if (lastColon > lastSeparator) {
    const suffix = result.slice(lastColon + 1);
    if (/^\d+(?::\d+)?$/.test(suffix)) {
      result = result.slice(0, lastColon);
    }
  }
  return result;
};
var normalizeReferencePath = (raw, cwd) => {
  let candidate = sanitizeReference(raw);
  if (!candidate || isCommentLikeReference(candidate)) {
    return null;
  }
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  candidate = stripLineSuffix(candidate);
  if (!candidate || isCommentLikeReference(candidate)) {
    return null;
  }
  if (candidate.startsWith("~")) {
    candidate = path.join(os.homedir(), candidate.slice(1));
  }
  if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(cwd, candidate);
  }
  candidate = path.normalize(candidate);
  const root = path.parse(candidate).root;
  if (candidate.length > root.length) {
    candidate = candidate.replace(/[\\/]+$/, "");
  }
  return candidate;
};
var formatDisplayPath = (absolutePath, cwd) => {
  const normalizedCwd = path.resolve(cwd);
  if (absolutePath.startsWith(normalizedCwd + path.sep)) {
    return path.relative(normalizedCwd, absolutePath);
  }
  return absolutePath;
};
var collectRecentFileReferences = (entries, cwd, limit) => {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
    const refs = extractFileReferencesFromEntry(entries[i]);
    for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
      const normalized = normalizeReferencePath(refs[j], cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      let exists = false;
      let isDirectory = false;
      if (existsSync(normalized)) {
        exists = true;
        const stats = statSync(normalized);
        isDirectory = stats.isDirectory();
      }
      results.push({
        path: normalized,
        display: formatDisplayPath(normalized, cwd),
        exists,
        isDirectory
      });
    }
  }
  return results;
};
var findLatestFileReference = (entries, cwd) => {
  const refs = collectRecentFileReferences(entries, cwd, 100);
  return refs.find((ref) => ref.exists) ?? null;
};
var toCanonicalPath = (inputPath) => {
  if (!existsSync(inputPath)) {
    return null;
  }
  try {
    const canonicalPath = realpathSync(inputPath);
    const stats = statSync(canonicalPath);
    return { canonicalPath, isDirectory: stats.isDirectory() };
  } catch {
    return null;
  }
};
var toCanonicalPathMaybeMissing = (inputPath) => {
  const resolvedPath = path.resolve(inputPath);
  if (!existsSync(resolvedPath)) {
    return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: false };
  }
  try {
    const canonicalPath = realpathSync(resolvedPath);
    const stats = statSync(canonicalPath);
    return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
  } catch {
    return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: true };
  }
};
var collectSessionFileChanges = (entries, cwd) => {
  const toolCalls = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const name = block.name;
          if (name === "write" || name === "edit") {
            const filePath = block.arguments?.path;
            if (filePath && typeof filePath === "string") {
              toolCalls.set(block.id, { path: filePath, name });
            }
          }
        }
      }
    }
  }
  const fileMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "toolResult") {
      const toolCall = toolCalls.get(msg.toolCallId);
      if (!toolCall) continue;
      const resolvedPath = path.isAbsolute(toolCall.path) ? toolCall.path : path.resolve(cwd, toolCall.path);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical) {
        continue;
      }
      const existing = fileMap.get(canonical.canonicalPath);
      if (existing) {
        existing.operations.add(toolCall.name);
        if (msg.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = msg.timestamp;
        }
      } else {
        fileMap.set(canonical.canonicalPath, {
          operations: /* @__PURE__ */ new Set([toolCall.name]),
          lastTimestamp: msg.timestamp
        });
      }
    }
  }
  return fileMap;
};
var splitNullSeparated = (value) => value.split("\0").filter(Boolean);
var getGitRoot = async (pi, cwd) => {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? root : null;
};
var getGitStatusMap = async (pi, cwd) => {
  const statusMap = /* @__PURE__ */ new Map();
  const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
  if (statusResult.code !== 0 || !statusResult.stdout) {
    return statusMap;
  }
  const entries = splitNullSeparated(statusResult.stdout);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const statusLabel = status.replace(/\s/g, "") || status.trim();
    let filePath = entry.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
      filePath = entries[i + 1];
      i += 1;
    }
    if (!filePath) continue;
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const canonical = toCanonicalPathMaybeMissing(resolved);
    if (!canonical) continue;
    statusMap.set(canonical.canonicalPath, {
      status: statusLabel,
      exists: canonical.exists,
      isDirectory: canonical.isDirectory
    });
  }
  return statusMap;
};
var getGitFiles = async (pi, gitRoot) => {
  const tracked = /* @__PURE__ */ new Set();
  const files = [];
  const trackedResult = await pi.exec("git", ["ls-files", "-z"], { cwd: gitRoot });
  if (trackedResult.code === 0 && trackedResult.stdout) {
    for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
      const resolvedPath = path.resolve(gitRoot, relativePath);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical) continue;
      tracked.add(canonical.canonicalPath);
      files.push(canonical);
    }
  }
  const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: gitRoot });
  if (untrackedResult.code === 0 && untrackedResult.stdout) {
    for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
      const resolvedPath = path.resolve(gitRoot, relativePath);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical) continue;
      files.push(canonical);
    }
  }
  return { tracked, files };
};
var buildFileEntries = async (pi, ctx) => {
  const entries = ctx.sessionManager.getBranch();
  const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
  const gitRoot = await getGitRoot(pi, ctx.cwd);
  const statusMap = gitRoot ? await getGitStatusMap(pi, gitRoot) : /* @__PURE__ */ new Map();
  let trackedSet = /* @__PURE__ */ new Set();
  let gitFiles = [];
  if (gitRoot) {
    const gitListing = await getGitFiles(pi, gitRoot);
    trackedSet = gitListing.tracked;
    gitFiles = gitListing.files;
  }
  const fileMap = /* @__PURE__ */ new Map();
  const upsertFile = (data) => {
    const existing = fileMap.get(data.canonicalPath);
    const displayPath = data.displayPath ?? formatDisplayPath(data.canonicalPath, ctx.cwd);
    if (existing) {
      fileMap.set(data.canonicalPath, {
        ...existing,
        ...data,
        displayPath,
        exists: data.exists ?? existing.exists,
        isDirectory: data.isDirectory ?? existing.isDirectory,
        isReferenced: existing.isReferenced || data.isReferenced === true,
        inRepo: existing.inRepo || data.inRepo === true,
        isTracked: existing.isTracked || data.isTracked === true,
        hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
        lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0)
      });
      return;
    }
    fileMap.set(data.canonicalPath, {
      canonicalPath: data.canonicalPath,
      resolvedPath: data.resolvedPath ?? data.canonicalPath,
      displayPath,
      exists: data.exists ?? true,
      isDirectory: data.isDirectory,
      status: data.status,
      inRepo: data.inRepo ?? false,
      isTracked: data.isTracked ?? false,
      isReferenced: data.isReferenced ?? false,
      hasSessionChange: data.hasSessionChange ?? false,
      lastTimestamp: data.lastTimestamp ?? 0
    });
  };
  for (const file of gitFiles) {
    upsertFile({
      canonicalPath: file.canonicalPath,
      resolvedPath: file.canonicalPath,
      isDirectory: file.isDirectory,
      exists: true,
      status: statusMap.get(file.canonicalPath)?.status,
      inRepo: true,
      isTracked: trackedSet.has(file.canonicalPath)
    });
  }
  for (const [canonicalPath, statusEntry] of statusMap.entries()) {
    if (fileMap.has(canonicalPath)) {
      continue;
    }
    const inRepo = gitRoot !== null && !path.relative(gitRoot, canonicalPath).startsWith("..") && !path.isAbsolute(path.relative(gitRoot, canonicalPath));
    upsertFile({
      canonicalPath,
      resolvedPath: canonicalPath,
      isDirectory: statusEntry.isDirectory,
      exists: statusEntry.exists,
      status: statusEntry.status,
      inRepo,
      isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??"
    });
  }
  const references = collectRecentFileReferences(entries, ctx.cwd, 200).filter((ref) => ref.exists);
  for (const ref of references) {
    const canonical = toCanonicalPath(ref.path);
    if (!canonical) continue;
    const inRepo = gitRoot !== null && !path.relative(gitRoot, canonical.canonicalPath).startsWith("..") && !path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));
    upsertFile({
      canonicalPath: canonical.canonicalPath,
      resolvedPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      exists: true,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo,
      isTracked: trackedSet.has(canonical.canonicalPath),
      isReferenced: true
    });
  }
  for (const [canonicalPath, change] of sessionChanges.entries()) {
    const canonical = toCanonicalPath(canonicalPath);
    if (!canonical) continue;
    const inRepo = gitRoot !== null && !path.relative(gitRoot, canonical.canonicalPath).startsWith("..") && !path.isAbsolute(path.relative(gitRoot, canonical.canonicalPath));
    upsertFile({
      canonicalPath: canonical.canonicalPath,
      resolvedPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      exists: true,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo,
      isTracked: trackedSet.has(canonical.canonicalPath),
      hasSessionChange: true,
      lastTimestamp: change.lastTimestamp
    });
  }
  const files = Array.from(fileMap.values()).sort((a, b) => {
    const aDirty = Boolean(a.status);
    const bDirty = Boolean(b.status);
    if (aDirty !== bDirty) {
      return aDirty ? -1 : 1;
    }
    if (a.inRepo !== b.inRepo) {
      return a.inRepo ? -1 : 1;
    }
    if (a.hasSessionChange !== b.hasSessionChange) {
      return a.hasSessionChange ? -1 : 1;
    }
    if (a.lastTimestamp !== b.lastTimestamp) {
      return b.lastTimestamp - a.lastTimestamp;
    }
    if (a.isReferenced !== b.isReferenced) {
      return a.isReferenced ? -1 : 1;
    }
    return a.displayPath.localeCompare(b.displayPath);
  });
  return { files, gitRoot };
};
var getEditableContent = (target) => {
  if (!existsSync(target.resolvedPath)) {
    return { allowed: false, reason: "File not found" };
  }
  const stats = statSync(target.resolvedPath);
  if (stats.isDirectory()) {
    return { allowed: false, reason: "Directories cannot be edited" };
  }
  if (stats.size >= MAX_EDIT_BYTES) {
    return { allowed: false, reason: "File is too large" };
  }
  const buffer = readFileSync(target.resolvedPath);
  if (buffer.includes(0)) {
    return { allowed: false, reason: "File contains null bytes" };
  }
  return { allowed: true, content: buffer.toString("utf8") };
};
var showActionSelector = async (ctx, options) => {
  const actions = [
    ...options.canDiff ? [{ value: "diff", label: "Diff in VS Code" }] : [],
    { value: "reveal", label: "Reveal in Finder" },
    { value: "open", label: "Open" },
    { value: "addToPrompt", label: "Add to prompt" },
    ...options.canQuickLook ? [{ value: "quicklook", label: "Open in Quick Look" }] : [],
    ...options.canEdit ? [{ value: "edit", label: "Edit" }] : []
  ];
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Choose action"))));
    const selectList = new SelectList(actions, actions.length, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text)
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    return {
      render(width) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data) {
        selectList.handleInput(data);
        tui.requestRender();
      }
    };
  });
};
var openPath = async (pi, ctx, target) => {
  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = await pi.exec(command, [target.resolvedPath]);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to open ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};
var openExternalEditor = (tui, editorCmd, content) => {
  const tmpFile = path.join(os.tmpdir(), `pi-files-edit-${Date.now()}.txt`);
  try {
    writeFileSync(tmpFile, content, "utf8");
    tui.stop();
    const [editor, ...editorArgs] = editorCmd.split(" ");
    const result = spawnSync(editor, [...editorArgs, tmpFile], { stdio: "inherit" });
    if (result.status === 0) {
      return readFileSync(tmpFile, "utf8").replace(/\n$/, "");
    }
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
    }
    tui.start();
    tui.requestRender(true);
  }
};
var editPath = async (ctx, target, content) => {
  const editorCmd = process.env.VISUAL || process.env.EDITOR;
  if (!editorCmd) {
    ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
    return;
  }
  const updated = await ctx.ui.custom((tui, theme, _kb, done) => {
    const status = new Text(theme.fg("dim", `Opening ${editorCmd}...`));
    queueMicrotask(() => {
      const result = openExternalEditor(tui, editorCmd, content);
      done(result);
    });
    return status;
  });
  if (updated === null) {
    ctx.ui.notify("Edit cancelled", "info");
    return;
  }
  try {
    writeFileSync(target.resolvedPath, updated, "utf8");
  } catch {
    ctx.ui.notify(`Failed to save ${target.displayPath}`, "error");
  }
};
var revealPath = async (pi, ctx, target) => {
  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }
  const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
  let command = "open";
  let args = [];
  if (process.platform === "darwin") {
    args = isDirectory ? [target.resolvedPath] : ["-R", target.resolvedPath];
  } else {
    command = "xdg-open";
    args = [isDirectory ? target.resolvedPath : path.dirname(target.resolvedPath)];
  }
  const result = await pi.exec(command, args);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to reveal ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};
var quickLookPath = async (pi, ctx, target) => {
  if (process.platform !== "darwin") {
    ctx.ui.notify("Quick Look is only available on macOS", "warning");
    return;
  }
  if (!existsSync(target.resolvedPath)) {
    ctx.ui.notify(`File not found: ${target.displayPath}`, "error");
    return;
  }
  const isDirectory = target.isDirectory || statSync(target.resolvedPath).isDirectory();
  if (isDirectory) {
    ctx.ui.notify("Quick Look only works on files", "warning");
    return;
  }
  const result = await pi.exec("qlmanage", ["-p", target.resolvedPath]);
  if (result.code !== 0) {
    const errorMessage = result.stderr?.trim() || `Failed to Quick Look ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};
var openDiff = async (pi, ctx, target, gitRoot) => {
  if (!gitRoot) {
    ctx.ui.notify("Git repository not found", "warning");
    return;
  }
  const relativePath = path.relative(gitRoot, target.resolvedPath).split(path.sep).join("/");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-files-"));
  const tmpFile = path.join(tmpDir, path.basename(target.displayPath));
  const existsInHead = await pi.exec("git", ["cat-file", "-e", `HEAD:${relativePath}`], { cwd: gitRoot });
  if (existsInHead.code === 0) {
    const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: gitRoot });
    if (result.code !== 0) {
      const errorMessage = result.stderr?.trim() || `Failed to diff ${target.displayPath}`;
      ctx.ui.notify(errorMessage, "error");
      return;
    }
    writeFileSync(tmpFile, result.stdout ?? "", "utf8");
  } else {
    writeFileSync(tmpFile, "", "utf8");
  }
  let workingPath = target.resolvedPath;
  if (!existsSync(target.resolvedPath)) {
    workingPath = path.join(tmpDir, `pi-files-working-${path.basename(target.displayPath)}`);
    writeFileSync(workingPath, "", "utf8");
  }
  const openResult = await pi.exec("code", ["--diff", tmpFile, workingPath], { cwd: gitRoot });
  if (openResult.code !== 0) {
    const errorMessage = openResult.stderr?.trim() || `Failed to open diff for ${target.displayPath}`;
    ctx.ui.notify(errorMessage, "error");
  }
};
var addFileToPrompt = (ctx, target) => {
  const mentionTarget = target.displayPath || target.resolvedPath;
  const mention = `@${mentionTarget}`;
  const current = ctx.ui.getEditorText();
  const separator = current && !current.endsWith(" ") ? " " : "";
  ctx.ui.setEditorText(`${current}${separator}${mention}`);
  ctx.ui.notify(`Added ${mention} to prompt`, "info");
};
var showFileSelector = async (ctx, files, selectedPath, gitRoot) => {
  const items = files.map((file) => {
    const directoryLabel = file.isDirectory ? " [directory]" : "";
    const statusSuffix = file.status ? ` [${file.status}]` : "";
    return {
      value: file.canonicalPath,
      label: `${file.displayPath}${directoryLabel}${statusSuffix}`
    };
  });
  let quickAction = null;
  const selection = await ctx.ui.custom((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0));
    const searchInput = new Input();
    container.addChild(searchInput);
    container.addChild(new Spacer(1));
    const listContainer = new Container();
    container.addChild(listContainer);
    container.addChild(
      new Text(theme.fg("dim", "Type to filter \u2022 enter to select \u2022 ctrl+shift+d diff \u2022 esc to cancel"), 0, 0)
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    let filteredItems = items;
    let selectList = null;
    const updateList = () => {
      listContainer.clear();
      if (filteredItems.length === 0) {
        listContainer.addChild(new Text(theme.fg("warning", "  No matching files"), 0, 0));
        selectList = null;
        return;
      }
      selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text)
      });
      if (selectedPath) {
        const index = filteredItems.findIndex((item) => item.value === selectedPath);
        if (index >= 0) {
          selectList.setSelectedIndex(index);
        }
      }
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      listContainer.addChild(selectList);
    };
    const applyFilter = () => {
      const query = searchInput.getValue();
      filteredItems = query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`) : items;
      updateList();
    };
    applyFilter();
    return {
      render(width) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, "ctrl+shift+d")) {
          const selected2 = selectList?.getSelectedItem();
          if (selected2) {
            const file = files.find((entry) => entry.canonicalPath === selected2.value);
            const canDiff = file?.isTracked && !file.isDirectory && Boolean(gitRoot);
            if (!canDiff) {
              ctx.ui.notify("Diff is only available for tracked files", "warning");
              return;
            }
            quickAction = "diff";
            done(selected2.value);
            return;
          }
        }
        if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
          if (selectList) {
            selectList.handleInput(data);
          } else if (keybindings.matches(data, "tui.select.cancel")) {
            done(null);
          }
          tui.requestRender();
          return;
        }
        searchInput.handleInput(data);
        applyFilter();
        tui.requestRender();
      }
    };
  });
  const selected = selection ? files.find((file) => file.canonicalPath === selection) ?? null : null;
  return { selected, quickAction };
};
var runFileBrowser = async (pi, ctx) => {
  if (!ctx.hasUI) {
    ctx.ui.notify("Files requires interactive mode", "error");
    return;
  }
  const { files, gitRoot } = await buildFileEntries(pi, ctx);
  if (files.length === 0) {
    ctx.ui.notify("No files found", "info");
    return;
  }
  let lastSelectedPath = null;
  while (true) {
    const { selected, quickAction } = await showFileSelector(ctx, files, lastSelectedPath, gitRoot);
    if (!selected) {
      ctx.ui.notify("Files cancelled", "info");
      return;
    }
    lastSelectedPath = selected.canonicalPath;
    const canQuickLook = process.platform === "darwin" && !selected.isDirectory;
    const editCheck = getEditableContent(selected);
    const canDiff = selected.isTracked && !selected.isDirectory && Boolean(gitRoot);
    if (quickAction === "diff") {
      await openDiff(pi, ctx, selected, gitRoot);
      continue;
    }
    const action = await showActionSelector(ctx, {
      canQuickLook,
      canEdit: editCheck.allowed,
      canDiff
    });
    if (!action) {
      continue;
    }
    switch (action) {
      case "quicklook":
        await quickLookPath(pi, ctx, selected);
        break;
      case "open":
        await openPath(pi, ctx, selected);
        break;
      case "edit":
        if (!editCheck.allowed || editCheck.content === void 0) {
          ctx.ui.notify(editCheck.reason ?? "File cannot be edited", "warning");
          break;
        }
        await editPath(ctx, selected, editCheck.content);
        break;
      case "addToPrompt":
        addFileToPrompt(ctx, selected);
        break;
      case "diff":
        await openDiff(pi, ctx, selected, gitRoot);
        break;
      default:
        await revealPath(pi, ctx, selected);
        break;
    }
  }
};
function files_default(pi) {
  pi.registerCommand("files", {
    description: "Browse files with git status and session references",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx);
    }
  });
  pi.registerShortcut("ctrl+shift+o", {
    description: "Browse files mentioned in the session",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx);
    }
  });
  pi.registerShortcut("ctrl+shift+r", {
    description: "Quick Look the latest file reference",
    handler: async (ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const latest = findLatestFileReference(entries, ctx.cwd);
      if (!latest) {
        ctx.ui.notify("No file reference found in the session", "warning");
        return;
      }
      const canonical = toCanonicalPath(latest.path);
      if (!canonical) {
        ctx.ui.notify(`File not found: ${latest.display}`, "error");
        return;
      }
      await quickLookPath(pi, ctx, {
        canonicalPath: canonical.canonicalPath,
        resolvedPath: canonical.canonicalPath,
        displayPath: latest.display,
        exists: true,
        isDirectory: canonical.isDirectory,
        status: void 0,
        inRepo: false,
        isTracked: false,
        isReferenced: true,
        hasSessionChange: false,
        lastTimestamp: 0
      });
    }
  });
}
export {
  files_default as default
};
//# sourceMappingURL=files.js.map
