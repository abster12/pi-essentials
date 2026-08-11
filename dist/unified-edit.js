// src/unified-edit.ts
import {
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  withFileMutationQueue
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
var TOOL_DESCRIPTION = `Edit files with one marked row edit script.

Row edit script format:
[filename]
@OPERATION
+insert row text
-delete row text

Every non-header line must be clearly marked: file headers use [path], operations use @, inserted content rows use +, deleted content rows use -. To insert or delete a real line that starts with +, -, or @, add the row marker first (for example ++literal plus, --literal minus, +@decorator). In @REPLACE, unified-diff style context rows starting with a single space are allowed and are used to locate a contiguous hunk; use @@ inside @REPLACE to separate multiple hunks.

Supported row operations:
@INS.PRE N       insert following + rows before 1-based line N
@INS.POST N      insert following + rows after 1-based line N
@INS.BEFORE      insert + rows before the located - anchor block using pi's edit matcher
@INS.AFTER       insert + rows after the located - anchor block using pi's edit matcher
@REPLACE         replace deleted-row blocks with inserted-row blocks using pi's edit matcher; - then + and + then - are both accepted. Space-prefixed context rows are allowed for unified-diff style hunks, including context-anchored insertions. Use @@ inside @REPLACE to separate multiple context hunks.
@APPEND          append following + rows at the end of the file
@DEL N-M         delete lines N through M inclusive; @DEL N also deletes one line; @DEL N..M, @DEL N..=M, and @DEL N.=M are accepted aliases

Examples:
[package.json]
@REPLACE
-  "version": "1.0.0",
+  "version": "1.0.1",

[src/main.ts]
@INS.PRE 1
+import { foo } from "./foo";
@INS.AFTER
-function main() {
+  setupFoo();
@DEL 20-23
@APPEND
+
+export { foo };`;
var TOOL_PROMPT_SNIPPET = "Edit files using one marked row script ([file], @operations, + insert rows, - delete rows).";
var TOOL_PROMPT_GUIDELINES = [
  "Use edit for file changes when you can express them as marked row operations.",
  "For edit row scripts, start each file section with [path/to/file], then use operation lines like @REPLACE, @INS.PRE N, @INS.POST N, @INS.BEFORE, @INS.AFTER, @DEL N-M, or @APPEND.",
  "For edit row scripts, every content row must have a marker: use + for inserted rows and - for deleted rows. To insert a literal line that starts with +, -, or @, keep the + row marker and put the literal character after it.",
  "Do not add unnecessary context lines to row scripts; only include the - rows needed to uniquely locate a replacement or insertion anchor and the + rows to insert.",
  "In @REPLACE, space-prefixed context rows are supported for unified-diff style hunks and context-anchored insertions; use @@ inside @REPLACE to separate multiple context hunks.",
  "Prefer @REPLACE with the smallest unique deleted block plus replacement rows for precise changes. @REPLACE uses pi's edit matcher: fuzzy normalization, uniqueness checks, and overlap checks all apply.",
  "Consecutive + rows or - rows form one block; for multiple replacements, use separate @REPLACE operations, alternating +/- block pairs, or @@-separated context hunks.",
  "Use @INS.BEFORE/@INS.AFTER with - rows for the anchor to avoid brittle line numbers when there is a unique nearby line or block.",
  "Use @INS.PRE/@INS.POST or @DEL only when line numbers are reliable from a recent read; line-number operations are applied sequentially in script order.",
  "Use @DEL N-M for inclusive line ranges. @DEL N deletes one line. Multiple [file] sections are allowed in one edit call."
];
var unifiedEditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: {
      type: "string",
      description: TOOL_DESCRIPTION
    }
  }
};
function prepareUnifiedArguments(args) {
  if (typeof args === "string") return { text: args };
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    for (const key of ["text", "patch", "input", "content"]) {
      const value = args[key];
      if (typeof value === "string") return { text: value };
    }
  }
  return args;
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("Operation aborted");
}
function detectLineEnding(content) {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}
function normalizeToLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function restoreLineEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
function normalizeForFuzzyMatch(text) {
  return text.normalize("NFKC").split("\n").map((line) => line.trimEnd()).join("\n").replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-").replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
function splitLinesWithEndings(content) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
function getLineSpans(content) {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}
function getReplacementLineRange(lines, replacement) {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }
  return { startLine, endLine: endLine + 1 };
}
function applyTextReplacements(content, replacements, offset = 0) {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}
function applyReplacementsPreservingUnchangedLines(originalContent, baseContent, replacements) {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyTextReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}
function stripBom(content) {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}
function isWholeLineBoundary(content, start, length, oldText) {
  const end = start + length;
  const startsOnBoundary = start === 0 || content[start - 1] === "\n";
  const consumesTrailingNewline = oldText.endsWith("\n");
  const endsOnBoundary = consumesTrailingNewline || end >= content.length || content[end] === "\n";
  return startsOnBoundary && endsOnBoundary;
}
function findMatchIndex(content, needle, wholeLines) {
  if (needle.length === 0) return -1;
  let index = content.indexOf(needle);
  while (index !== -1) {
    if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) return index;
    index = content.indexOf(needle, index + 1);
  }
  return -1;
}
function fuzzyFindText(content, oldText, wholeLines) {
  const exactIndex = findMatchIndex(content, oldText, wholeLines);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content
    };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = findMatchIndex(fuzzyContent, fuzzyOldText, wholeLines);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent
  };
}
function countNeedleOccurrences(content, needle, wholeLines) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) count++;
    index = content.indexOf(needle, index + (wholeLines ? 1 : needle.length));
  }
  return count;
}
function countOccurrences(content, oldText, wholeLines) {
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) {
    return countNeedleOccurrences(content, oldText, wholeLines);
  }
  return countNeedleOccurrences(normalizeForFuzzyMatch(content), fuzzyOldText, wholeLines);
}
function getNotFoundError(path, editIndex, totalEdits) {
  const what = totalEdits === 1 ? "the exact text" : `edits[${editIndex}]`;
  const noun = totalEdits === 1 ? "old text" : "oldText";
  return new Error(
    `Could not find ${what} in ${path}. The ${noun} must match exactly including all whitespace and newlines.`
  );
}
function getDuplicateError(path, editIndex, totalEdits, occurrences) {
  const what = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
  const noun = totalEdits === 1 ? "The text" : "Each oldText";
  return new Error(
    `Found ${occurrences} occurrences of ${what} in ${path}. ${noun} must be unique. Please provide more context to make it unique.`
  );
}
function getEmptyOldTextError(path, editIndex, totalEdits) {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}
function getNoChangeError(path, totalEdits) {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}
function applyEditsToNormalizedContent(normalizedContent, edits, path, options) {
  const wholeLines = options?.requireWholeLines === true;
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText)
  }));
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText, wholeLines));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const matchedEdits = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText, wholeLines);
    if (!matchResult.found) {
      throw getNotFoundError(path, i, normalizedEdits.length);
    }
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText, wholeLines);
    if (occurrences > 1) {
      throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText
    });
  }
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      );
    }
  }
  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits) : applyTextReplacements(replacementBaseContent, matchedEdits);
  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }
  return { baseContent, newContent };
}
function normalizePath(path) {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("File path cannot be empty.");
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}
function resolveToCwd(cwd, path) {
  const normalized = normalizePath(path);
  return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}
async function readExistingNormalized(path, absolutePath) {
  try {
    return normalizeToLF(stripBom(await readFile(absolutePath, "utf-8")).text);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? ` (${err.code})` : "";
    throw new Error(`Could not read ${path}${code}.`);
  }
}
async function maybeReadNormalized(absolutePath) {
  try {
    return normalizeToLF(stripBom(await readFile(absolutePath, "utf-8")).text);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
function splitContent(content) {
  const finalNewline = content.endsWith("\n");
  const body = finalNewline ? content.slice(0, -1) : content;
  return { lines: body.length === 0 ? [] : body.split("\n"), finalNewline };
}
function joinContent(doc) {
  const body = doc.lines.join("\n");
  return doc.finalNewline ? `${body}
` : body;
}
function parseRowScript(text) {
  const lines = normalizeToLF(text).split("\n");
  const files = [];
  let currentFile;
  let currentOp;
  function finishOp() {
    if (!currentOp) return;
    if (!currentFile) throw new Error("Internal parser error: operation without file.");
    if ("rows" in currentOp && currentOp.rows.length === 0) {
      throw new Error(`${currentOp.kind} in ${currentFile.path} has no + rows.`);
    }
    if ("groups" in currentOp && currentOp.groups.length === 0) {
      const opName = currentOp.kind === "replace" ? "@REPLACE" : currentOp.kind === "insertBeforeAnchor" ? "@INS.BEFORE" : "@INS.AFTER";
      throw new Error(`${opName} in ${currentFile.path} has no + or - rows.`);
    }
    currentFile.ops.push(currentOp);
    currentOp = void 0;
  }
  function requireFile(lineNumber) {
    if (!currentFile) throw new Error(`Line ${lineNumber}: expected a [filename] header before operations or rows.`);
    return currentFile;
  }
  function pushGroup(marker, linesToAdd) {
    if (!currentOp || !("groups" in currentOp)) throw new Error("Internal parser error: group row without group operation.");
    if (marker === "@@") {
      currentOp.groups.push({ marker, lines: [] });
      return;
    }
    const lastGroup = currentOp.groups[currentOp.groups.length - 1];
    if (lastGroup && lastGroup.marker === marker) lastGroup.lines.push(...linesToAdd);
    else currentOp.groups.push({ marker, lines: [...linesToAdd] });
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const fileMatch = /^\[(.+)]\s*$/.exec(trimmed);
    if (fileMatch) {
      finishOp();
      currentFile = { path: normalizePath(fileMatch[1]), ops: [] };
      files.push(currentFile);
      continue;
    }
    if (raw.startsWith("@@")) {
      if (currentOp && "groups" in currentOp) pushGroup("@@", []);
      continue;
    }
    if (raw.startsWith("@")) {
      const file = requireFile(lineNumber);
      finishOp();
      const insertMatch = /^@INS\.(PRE|POST)\s+(\d+)\s*$/i.exec(trimmed);
      if (insertMatch) {
        const line = Number(insertMatch[2]);
        if (!Number.isSafeInteger(line) || line < 1) throw new Error(`Line ${lineNumber}: insert line number must be >= 1.`);
        currentOp = insertMatch[1].toUpperCase() === "PRE" ? { kind: "insertBefore", line, rows: [] } : { kind: "insertAfter", line, rows: [] };
        continue;
      }
      if (/^@INS\.BEFORE\s*$/i.test(trimmed)) {
        currentOp = { kind: "insertBeforeAnchor", groups: [] };
        continue;
      }
      if (/^@INS\.AFTER\s*$/i.test(trimmed)) {
        currentOp = { kind: "insertAfterAnchor", groups: [] };
        continue;
      }
      if (/^@APPEND\s*$/i.test(trimmed)) {
        currentOp = { kind: "append", rows: [] };
        continue;
      }
      if (/^@REPLACE\s*$/i.test(trimmed)) {
        currentOp = { kind: "replace", groups: [] };
        continue;
      }
      const delMatch = /^@DEL\s+(\d+)(?:(?:\s*-\s*|\s*\.\.=?\s*|\s*\.=\s*)(\d+))?\s*$/i.exec(trimmed);
      if (delMatch) {
        const startLine = Number(delMatch[1]);
        const endLine = delMatch[2] === void 0 ? startLine : Number(delMatch[2]);
        if (startLine < 1 || endLine < startLine) throw new Error(`Line ${lineNumber}: invalid inclusive delete range ${trimmed}.`);
        file.ops.push({ kind: "delete", startLine, endLine });
        continue;
      }
      throw new Error(`Line ${lineNumber}: unknown edit operation ${trimmed}. Expected @INS.PRE, @INS.POST, @INS.BEFORE, @INS.AFTER, @REPLACE, @APPEND, or @DEL.`);
    }
    if (raw.startsWith("+") || raw.startsWith("-")) {
      requireFile(lineNumber);
      if (!currentOp) throw new Error(`Line ${lineNumber}: row appears before an operation.`);
      const marker = raw[0];
      const body = raw.slice(1);
      if ("rows" in currentOp) {
        if (marker !== "+") throw new Error(`Line ${lineNumber}: ${currentOp.kind} only accepts + rows.`);
        currentOp.rows.push(body);
        continue;
      }
      if (!("groups" in currentOp)) throw new Error(`Line ${lineNumber}: unexpected row for @DEL.`);
      pushGroup(marker, [body]);
      continue;
    }
    if (raw.startsWith(" ") && currentOp && "groups" in currentOp) {
      requireFile(lineNumber);
      if (currentOp.kind === "replace") pushGroup(" ", [raw.slice(1)]);
      continue;
    }
    throw new Error(`Line ${lineNumber}: invalid row script line. Every non-empty row must start with [filename], @, +, -, or a space-prefixed @REPLACE context row.`);
  }
  finishOp();
  if (files.length === 0) throw new Error("Row edit script must contain at least one [filename] section.");
  for (const file of files) {
    if (file.ops.length === 0) throw new Error(`File section [${file.path}] has no operations.`);
  }
  return files;
}
function getContextualReplacePairs(path, groups) {
  const hunks = [[]];
  for (const group of groups) {
    if (group.marker === "@@") {
      if (hunks[hunks.length - 1].length > 0) hunks.push([]);
      continue;
    }
    if (group.lines.length > 0) hunks[hunks.length - 1].push(group);
  }
  const pairs = [];
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (hunk.length === 0) continue;
    const oldLines = [];
    const newLines = [];
    let hasChange = false;
    for (const group of hunk) {
      if (group.marker === " ") {
        oldLines.push(...group.lines);
        newLines.push(...group.lines);
      } else if (group.marker === "-") {
        oldLines.push(...group.lines);
        hasChange = true;
      } else if (group.marker === "+") {
        newLines.push(...group.lines);
        hasChange = true;
      }
    }
    const label = hunks.length > 1 ? ` hunk ${i + 1}` : "";
    if (!hasChange) throw new Error(`@REPLACE${label} in ${path} has no + or - rows.`);
    if (oldLines.length === 0) {
      throw new Error(`@REPLACE${label} in ${path} has + rows but no - or context rows to locate the insertion.`);
    }
    pairs.push({ oldLines, newLines });
  }
  if (pairs.length === 0) throw new Error(`@REPLACE in ${path} has no rows.`);
  return pairs;
}
function getReplacePairs(path, op) {
  const groups = op.groups.filter((group) => group.marker === "@@" || group.lines.length > 0);
  if (groups.length === 0) throw new Error(`@REPLACE in ${path} has no rows.`);
  if (groups.some((group) => group.marker === " " || group.marker === "@@")) return getContextualReplacePairs(path, groups);
  const changeGroups = groups;
  if (changeGroups.length === 1) {
    if (changeGroups[0].marker === "-") return [{ oldLines: changeGroups[0].lines, newLines: [] }];
    throw new Error(`@REPLACE in ${path} has + rows but no - rows to locate the replacement.`);
  }
  if (changeGroups.length % 2 !== 0) {
    throw new Error(`@REPLACE in ${path} has an odd number of +/- blocks. Pair each deleted block with an inserted block.`);
  }
  const pairs = [];
  for (let i = 0; i < changeGroups.length; i += 2) {
    const a = changeGroups[i];
    const b = changeGroups[i + 1];
    if (a.marker === b.marker) throw new Error(`@REPLACE in ${path} has two adjacent ${a.marker} blocks; expected paired + and - blocks.`);
    pairs.push({ oldLines: a.marker === "-" ? a.lines : b.lines, newLines: a.marker === "+" ? a.lines : b.lines });
  }
  return pairs;
}
function rowEditFromPair(pair, deleteWholeRows) {
  let oldText = pair.oldLines.join("\n");
  const newText = pair.newLines.join("\n");
  if (deleteWholeRows && pair.newLines.length === 0) oldText += "\n";
  return { oldText, newText };
}
function applyReplaceOperation(content, path, op) {
  const pairs = getReplacePairs(path, op);
  const hasDeletionOnly = pairs.some((pair) => pair.newLines.length === 0);
  const primaryEdits = pairs.map((pair) => rowEditFromPair(pair, true));
  try {
    return applyEditsToNormalizedContent(content, primaryEdits, path, { requireWholeLines: true }).newContent;
  } catch (err) {
    if (!hasDeletionOnly) throw err;
    const fallbackEdits = pairs.map((pair) => rowEditFromPair(pair, false));
    return applyEditsToNormalizedContent(content, fallbackEdits, path, { requireWholeLines: true }).newContent;
  }
}
function applyAnchorInsertOperation(content, path, op) {
  const opName = op.kind === "insertBeforeAnchor" ? "@INS.BEFORE" : "@INS.AFTER";
  const groups = op.groups.filter(
    (group) => (group.marker === "+" || group.marker === "-") && group.lines.length > 0
  );
  if (groups.length !== 2 || groups[0].marker === groups[1].marker) {
    throw new Error(`${opName} in ${path} must contain exactly one - anchor block and one + insert block.`);
  }
  const anchorText = (groups[0].marker === "-" ? groups[0] : groups[1]).lines.join("\n");
  const insertText = (groups[0].marker === "+" ? groups[0] : groups[1]).lines.join("\n");
  const newText = op.kind === "insertBeforeAnchor" ? `${insertText}
${anchorText}` : `${anchorText}
${insertText}`;
  return applyEditsToNormalizedContent(content, [{ oldText: anchorText, newText }], path, {
    requireWholeLines: true
  }).newContent;
}
function applyRowOperations(path, content, ops) {
  const doc = splitContent(content);
  for (const op of ops) {
    switch (op.kind) {
      case "insertBefore":
      case "insertAfter": {
        const index = op.kind === "insertBefore" ? op.line - 1 : op.line;
        if (index < 0 || index > doc.lines.length) {
          const opName = op.kind === "insertBefore" ? "@INS.PRE" : "@INS.POST";
          throw new Error(`${opName} ${op.line} is outside ${path}; file has ${doc.lines.length} line(s).`);
        }
        doc.lines.splice(index, 0, ...op.rows);
        if (index + op.rows.length === doc.lines.length) doc.finalNewline = true;
        break;
      }
      case "append":
        doc.lines.push(...op.rows);
        doc.finalNewline = true;
        break;
      case "delete":
        if (op.endLine > doc.lines.length) throw new Error(`@DEL ${op.startLine}-${op.endLine} is outside ${path}; file has ${doc.lines.length} line(s).`);
        doc.lines.splice(op.startLine - 1, op.endLine - op.startLine + 1);
        if (doc.lines.length === 0) doc.finalNewline = false;
        break;
      case "replace":
      case "insertBeforeAnchor":
      case "insertAfterAnchor": {
        const next = op.kind === "replace" ? applyReplaceOperation(joinContent(doc), path, op) : applyAnchorInsertOperation(joinContent(doc), path, op);
        Object.assign(doc, splitContent(next));
        break;
      }
    }
  }
  return joinContent(doc);
}
function createUpdatePlan(path, absolutePath, oldText, newText) {
  if (oldText === newText) return void 0;
  return { kind: oldText.length === 0 ? "write" : "update", path, absolutePath, oldText, newText };
}
function createSnapshotStore(cwd, read) {
  const snapshots = /* @__PURE__ */ new Map();
  const ordered = [];
  return {
    async get(path) {
      const absolutePath = resolveToCwd(cwd, path);
      let snapshot = snapshots.get(absolutePath);
      if (!snapshot) {
        const original = await read(path, absolutePath);
        snapshot = { path, absolutePath, original, current: original };
        snapshots.set(absolutePath, snapshot);
        ordered.push(snapshot);
      }
      return snapshot;
    },
    collectChanges(noChangesError) {
      const changes = [];
      for (const { path, absolutePath, original, current } of ordered) {
        if (original === current) continue;
        if (original === null && current !== null) {
          changes.push({ kind: "add", path, absolutePath, oldText: "", newText: current });
        } else if (original !== null && current === null) {
          changes.push({ kind: "delete", path, absolutePath, oldText: original, newText: "" });
        } else if (original !== null && current !== null) {
          const plan = createUpdatePlan(path, absolutePath, original, current);
          if (plan) changes.push(plan);
        }
      }
      if (changes.length === 0) throw new Error(noChangesError);
      return changes;
    }
  };
}
async function buildRowPlan(text, cwd) {
  const scripts = parseRowScript(text);
  const store = createSnapshotStore(cwd, readExistingNormalized);
  for (const script of scripts) {
    const snapshot = await store.get(script.path);
    if (snapshot.current === null) throw new Error(`Cannot edit deleted file ${script.path}.`);
    snapshot.current = applyRowOperations(script.path, snapshot.current, script.ops);
  }
  return { mode: "rows", changes: store.collectChanges("The row edit script produced no changes.") };
}
function isPatchPayload(text) {
  const trimmed = normalizeToLF(text).trim();
  return trimmed.startsWith("*** Begin Patch") && trimmed.endsWith("*** End Patch");
}
function isPatchLikePayload(text) {
  return normalizeToLF(text).trimStart().startsWith("*** Begin Patch");
}
function patchTextForPreview(text) {
  const normalized = normalizeToLF(text).trimEnd();
  return normalized.endsWith("*** End Patch") ? normalized : `${normalized}
*** End Patch`;
}
function parseUpdateChunk(lines, startIndex, lastContentLine, allowMissingContext) {
  let i = startIndex;
  let changeContext;
  const first = lines[i].trimEnd();
  if (first === "@@") i++;
  else if (first.startsWith("@@ ")) {
    changeContext = first.slice(3);
    i++;
  } else if (!allowMissingContext) {
    throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
  }
  const oldLines = [];
  const newLines = [];
  let parsed = 0;
  let isEndOfFile = false;
  while (i <= lastContentLine) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    if (trimmed === "*** End of File") {
      if (parsed === 0) throw new Error("Update hunk does not contain any lines");
      isEndOfFile = true;
      i++;
      break;
    }
    if (parsed > 0 && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) break;
    if (raw.length === 0) {
      oldLines.push("");
      newLines.push("");
      parsed++;
      i++;
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === " ") {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === "-") oldLines.push(body);
    else if (marker === "+") newLines.push(body);
    else if (parsed === 0) throw new Error(`Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`);
    else break;
    parsed++;
    i++;
  }
  if (parsed === 0) throw new Error("Update hunk does not contain any lines");
  return { chunk: { changeContext, oldLines, newLines, isEndOfFile }, nextIndex: i };
}
function parsePatch(patchText) {
  const lines = normalizeToLF(patchText).trim().split("\n");
  if (lines.length < 2) throw new Error("Patch is empty or invalid");
  if (lines[0].trim() !== "*** Begin Patch") throw new Error("The first line of the patch must be '*** Begin Patch'");
  if (lines[lines.length - 1].trim() !== "*** End Patch") throw new Error("The last line of the patch must be '*** End Patch'");
  const operations = [];
  let i = 1;
  const lastContentLine = lines.length - 2;
  while (i <= lastContentLine) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    const line = lines[i].trim();
    if (line.startsWith("*** Add File: ")) {
      const path = normalizePath(line.slice("*** Add File: ".length));
      i++;
      const contentLines = [];
      while (i <= lastContentLine) {
        const next = lines[i];
        if (next.trim().startsWith("*** ")) break;
        if (!next.startsWith("+")) throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`);
        contentLines.push(next.slice(1));
        i++;
      }
      operations.push({ kind: "add", path, contents: contentLines.length > 0 ? `${contentLines.join("\n")}
` : "" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      operations.push({ kind: "delete", path: normalizePath(line.slice("*** Delete File: ".length)) });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = normalizePath(line.slice("*** Update File: ".length));
      i++;
      if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) throw new Error("Patch move operations (*** Move to:) are not supported.");
      const chunks = [];
      while (i <= lastContentLine) {
        if (lines[i].trim() === "") {
          i++;
          continue;
        }
        if (lines[i].trim().startsWith("*** ")) break;
        const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
        chunks.push(parsed.chunk);
        i = parsed.nextIndex;
      }
      if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`);
      operations.push({ kind: "update", path, chunks });
      continue;
    }
    throw new Error(`'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`);
  }
  return operations;
}
function seekSequence(lines, pattern, start, eof = false) {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return void 0;
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : Math.max(0, start);
  const searchEnd = lines.length - pattern.length;
  const passes = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim()
  ];
  for (const equal of passes) {
    for (let i = searchStart; i <= searchEnd; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!equal(lines[i + j], pattern[j])) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return void 0;
}
function deriveUpdatedContent(filePath, currentContent, chunks) {
  const originalLines = currentContent.split("\n");
  if (originalLines[originalLines.length - 1] === "") originalLines.pop();
  const replacements = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== void 0) {
      const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (ctxIndex === void 0) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      lineIndex = ctxIndex + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([originalLines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === void 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === void 0) throw new Error(`Failed to find expected lines in ${filePath}:
${chunk.oldLines.join("\n")}`);
    replacements.push([found, pattern.length, [...newSlice]]);
    lineIndex = found + pattern.length;
  }
  const newLines = [...originalLines];
  for (const [start, oldLen, newSegment] of replacements.sort((a, b) => b[0] - a[0])) {
    newLines.splice(start, oldLen, ...newSegment);
  }
  if (newLines[newLines.length - 1] !== "") newLines.push("");
  return newLines.join("\n");
}
async function buildPatchPlan(text, cwd) {
  const operations = parsePatch(text);
  const store = createSnapshotStore(cwd, (_path, absolutePath) => maybeReadNormalized(absolutePath));
  for (const op of operations) {
    const snapshot = await store.get(op.path);
    if (op.kind === "add") {
      const contents = normalizeToLF(op.contents);
      snapshot.current = contents.endsWith("\n") ? contents : `${contents}
`;
      continue;
    }
    if (op.kind === "delete") {
      if (snapshot.current === null) throw new Error(`Failed to delete ${op.path}: file does not exist.`);
      snapshot.current = null;
      continue;
    }
    if (snapshot.current === null) throw new Error(`Failed to update ${op.path}: file does not exist.`);
    snapshot.current = deriveUpdatedContent(op.path, snapshot.current, op.chunks);
  }
  return { mode: "patch", changes: store.collectChanges("The patch produced no changes.") };
}
async function buildPlan(text, cwd) {
  return isPatchLikePayload(text) ? buildPatchPlan(text, cwd) : buildRowPlan(text, cwd);
}
async function buildPreviewPlan(text, cwd, argsComplete) {
  if (!argsComplete && isPatchLikePayload(text) && !isPatchPayload(text)) {
    return buildPatchPlan(patchTextForPreview(text), cwd);
  }
  return buildPlan(text, cwd);
}
async function checkCanCreatePath(absolutePath) {
  let dir = dirname(absolutePath);
  while (true) {
    try {
      await access(dir, constants.W_OK);
      return;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      const parent = dirname(dir);
      if (parent === dir) throw err;
      dir = parent;
    }
  }
}
async function preflightPlan(plan, signal) {
  for (const change of plan.changes) {
    throwIfAborted(signal);
    if (change.kind === "add") {
      await checkCanCreatePath(change.absolutePath);
      continue;
    }
    if (change.kind === "update") {
      applyEditsToNormalizedContent(change.oldText, [{ oldText: change.oldText, newText: change.newText }], change.path);
    }
    await access(change.absolutePath, constants.R_OK | constants.W_OK);
  }
}
function detailsForChange(path, oldText, newText) {
  const { diff, firstChangedLine } = generateDiffString(oldText, newText);
  return { diff, patch: generateUnifiedPatch(path, oldText, newText), firstChangedLine };
}
async function readFileForMutation(absolutePath) {
  await access(absolutePath, constants.R_OK | constants.W_OK);
  const { bom, text } = stripBom(await readFile(absolutePath, "utf-8"));
  return { bom, ending: detectLineEnding(text), content: normalizeToLF(text) };
}
async function applyUpdateChange(change, signal) {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal);
    const file = await readFileForMutation(change.absolutePath);
    throwIfAborted(signal);
    const { baseContent, newContent } = applyEditsToNormalizedContent(
      file.content,
      [{ oldText: change.oldText, newText: change.newText }],
      change.path
    );
    await writeFile(change.absolutePath, file.bom + restoreLineEndings(newContent, file.ending), "utf-8");
    throwIfAborted(signal);
    return detailsForChange(change.path, baseContent, newContent);
  });
}
async function applyWriteChange(change, signal) {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal);
    const file = await readFileForMutation(change.absolutePath);
    if (file.content !== change.oldText) {
      throw new Error(`Could not edit ${change.path}: file changed since preflight.`);
    }
    await writeFile(change.absolutePath, file.bom + restoreLineEndings(change.newText, file.ending), "utf-8");
    return detailsForChange(change.path, file.content, change.newText);
  });
}
async function applyAddChange(change, signal) {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal);
    const existing = await maybeReadNormalized(change.absolutePath);
    if (existing !== null) throw new Error(`Could not add ${change.path}: file already exists.`);
    await mkdir(dirname(change.absolutePath), { recursive: true });
    await writeFile(change.absolutePath, change.newText, "utf-8");
    return detailsForChange(change.path, "", change.newText);
  });
}
async function applyDeleteChange(change, signal) {
  return withFileMutationQueue(change.absolutePath, async () => {
    throwIfAborted(signal);
    await access(change.absolutePath, constants.R_OK | constants.W_OK);
    const current = await readExistingNormalized(change.path, change.absolutePath);
    if (current !== change.oldText) throw new Error(`Could not delete ${change.path}: file changed since preflight.`);
    await unlink(change.absolutePath);
    return detailsForChange(change.path, change.oldText, "");
  });
}
async function applyPlan(plan, signal) {
  const appliers = {
    update: applyUpdateChange,
    write: applyWriteChange,
    add: applyAddChange,
    delete: applyDeleteChange
  };
  const files = [];
  for (const change of plan.changes) {
    throwIfAborted(signal);
    const details = await appliers[change.kind](change, signal);
    files.push({ path: change.path, kind: change.kind, details });
  }
  return combineDetails(files);
}
function combineDetails(files) {
  const diff = files.length === 1 ? files[0].details.diff : files.map((file) => `File: ${file.path}
${file.details.diff}`).join("\n\n");
  const patch = files.map((file) => file.details.patch).join("\n");
  const firstChangedLine = files.find((file) => file.details.firstChangedLine !== void 0)?.details.firstChangedLine;
  return { diff, patch, firstChangedLine, files };
}
function formatSummary(details) {
  if (details.files.length === 1) {
    const file = details.files[0];
    const verb = file.kind === "add" ? "Added" : file.kind === "delete" ? "Deleted" : "Edited";
    return `${verb} ${file.path}.`;
  }
  return `Applied unified edit to ${details.files.length} file(s).
${details.files.map((file, index) => `${index + 1}. ${file.kind} ${file.path}`).join("\n")}`;
}
function previewForPlan(plan) {
  const details = combineDetails(
    plan.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      details: detailsForChange(change.path, change.oldText, change.newText)
    }))
  );
  return { diff: details.diff, files: uniquePaths(plan.changes.map((change) => change.path)), firstChangedLine: details.firstChangedLine };
}
function str(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}
function shortenPath(path) {
  if (typeof path !== "string") return "";
  const home = homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}
function linkPath(styledText, rawPath, cwd) {
  if (!getCapabilities().hyperlinks) return styledText;
  return hyperlink(styledText, pathToFileURL(resolveToCwd(cwd, rawPath)).href);
}
function renderToolPath(rawPath, theme, cwd, options) {
  if (rawPath === null) return theme.fg("error", "[invalid arg]");
  const value = rawPath || options?.emptyFallback;
  if (!value) return theme.fg("toolOutput", "...");
  return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
function uniquePaths(paths) {
  return Array.from(new Set(paths));
}
function uniquePathsForCwd(paths, cwd) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const path of paths) {
    let key = path;
    try {
      key = resolveToCwd(cwd, path);
    } catch {
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique;
}
function safeRenderablePath(path) {
  try {
    return normalizePath(path);
  } catch {
    return void 0;
  }
}
function extractRowHeaderPaths(text) {
  const paths = [];
  const lines = normalizeToLF(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const complete = /^\[(.+)]\s*$/.exec(trimmed);
    const partial = i === lines.length - 1 ? /^\[([^\]]+)$/.exec(trimmed) : null;
    const path = safeRenderablePath(complete?.[1] ?? partial?.[1] ?? "");
    if (path) paths.push(path);
  }
  return uniquePaths(paths);
}
function extractPatchHeaderPaths(text) {
  const paths = [];
  const prefixes = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
  for (const raw of normalizeToLF(text).split("\n")) {
    const trimmed = raw.trim();
    for (const prefix of prefixes) {
      if (!trimmed.startsWith(prefix)) continue;
      const path = safeRenderablePath(trimmed.slice(prefix.length));
      if (path) paths.push(path);
      break;
    }
  }
  return uniquePaths(paths);
}
function getRenderablePaths(text) {
  if (!text) return void 0;
  const patchLike = isPatchLikePayload(text);
  const fallback = patchLike ? extractPatchHeaderPaths(text) : extractRowHeaderPaths(text);
  try {
    const paths = patchLike ? parsePatch(isPatchPayload(text) ? text : patchTextForPreview(text)).map((op) => op.path) : parseRowScript(text).map((script) => script.path);
    const unique = uniquePaths(paths);
    return unique.length > 0 ? unique : fallback.length > 0 ? fallback : void 0;
  } catch {
    return fallback.length > 0 ? fallback : void 0;
  }
}
function renderUnifiedPathLabel(paths, theme, cwd) {
  const unique = paths ? uniquePathsForCwd(paths, cwd) : void 0;
  if (!unique || unique.length === 0) return renderToolPath("", theme, cwd);
  if (unique.length === 1) return renderToolPath(str(unique[0]), theme, cwd);
  return theme.fg("accent", `${unique.length} files`);
}
function formatUnifiedEditCall(text, preview, theme, cwd) {
  const title = theme.fg("toolTitle", theme.bold("edit"));
  const paths = preview && !("error" in preview) ? preview.files : getRenderablePaths(text);
  return `${title} ${renderUnifiedPathLabel(paths, theme, cwd)}`;
}
function createUnifiedEditCallRenderComponent() {
  return Object.assign(new Box(1, 1, (text) => text), {
    preview: void 0,
    previewArgsKey: void 0,
    previewBuiltFromCompleteArgs: false,
    previewPending: false,
    previewPendingArgsKey: void 0,
    previewSuppressedArgsKey: void 0,
    settledError: false
  });
}
function getUnifiedEditCallRenderComponent(state, lastComponent) {
  if (lastComponent instanceof Box) {
    const component2 = lastComponent;
    state.callComponent = component2;
    return component2;
  }
  if (state.callComponent) return state.callComponent;
  const component = createUnifiedEditCallRenderComponent();
  state.callComponent = component;
  return component;
}
function getUnifiedEditHeaderBg(preview, settledError, theme) {
  if (preview) {
    if ("error" in preview) return (text) => theme.bg("toolErrorBg", text);
    return (text) => theme.bg("toolSuccessBg", text);
  }
  if (settledError) return (text) => theme.bg("toolErrorBg", text);
  return (text) => theme.bg("toolPendingBg", text);
}
function setUnifiedEditPreview(component, preview, argsKey, argsComplete = true) {
  const current = component.preview;
  const changed = current === void 0 || ("error" in current && "error" in preview ? current.error !== preview.error : "error" in current !== "error" in preview) || !("error" in current) && !("error" in preview) && (current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine || current.files.join("\0") !== preview.files.join("\0"));
  component.preview = preview;
  component.previewArgsKey = argsKey;
  component.previewBuiltFromCompleteArgs = argsComplete;
  component.previewPending = false;
  component.previewPendingArgsKey = void 0;
  component.previewSuppressedArgsKey = void 0;
  return changed;
}
function requestUnifiedEditPreview(component, text, argsKey, cwd, argsComplete, invalidate) {
  const hasUsablePreview = component.preview && (!argsComplete || component.previewBuiltFromCompleteArgs);
  if (!text || !argsKey || hasUsablePreview || component.previewPendingArgsKey === argsKey) return;
  if (!argsComplete && component.previewSuppressedArgsKey === argsKey) return;
  component.previewPending = true;
  component.previewPendingArgsKey = argsKey;
  const requestKey = argsKey;
  void buildPreviewPlan(text, cwd, argsComplete).then((plan) => previewForPlan(plan)).catch((err) => {
    if (!argsComplete) return void 0;
    return { error: err instanceof Error ? err.message : String(err) };
  }).then((preview) => {
    if (component.previewArgsKey !== requestKey) return;
    component.previewPending = false;
    component.previewPendingArgsKey = void 0;
    if (preview) {
      setUnifiedEditPreview(component, preview, requestKey, argsComplete);
    } else {
      component.previewSuppressedArgsKey = requestKey;
    }
    invalidate();
  });
}
function buildUnifiedEditCallComponent(component, text, theme, cwd) {
  component.setBgFn(getUnifiedEditHeaderBg(component.preview, component.settledError, theme));
  component.clear();
  component.addChild(new Text(formatUnifiedEditCall(text, component.preview, theme, cwd), 0, 0));
  if (!component.preview) return component;
  const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
  component.addChild(new Spacer(1));
  component.addChild(new Text(body, 0, 0));
  return component;
}
function formatUnifiedEditResult(preview, result, theme, isError) {
  const previewDiff = preview && !("error" in preview) ? preview.diff : void 0;
  const previewError = preview && "error" in preview ? preview.error : void 0;
  if (isError) {
    const errorText = result.content.map((item) => item.text || "").join("\n");
    if (!errorText || errorText === previewError) return void 0;
    return theme.fg("error", errorText);
  }
  const resultDiff = result.details?.diff;
  if (resultDiff && resultDiff !== previewDiff) return renderDiff(resultDiff);
  return void 0;
}
function unifiedEditExtension(pi) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: TOOL_DESCRIPTION,
    promptSnippet: TOOL_PROMPT_SNIPPET,
    promptGuidelines: TOOL_PROMPT_GUIDELINES,
    parameters: unifiedEditSchema,
    renderShell: "self",
    prepareArguments: prepareUnifiedArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = params.text;
      if (typeof text !== "string" || text.trim() === "") throw new Error("edit requires a non-empty text payload.");
      const plan = await buildPlan(text, ctx.cwd);
      try {
        await preflightPlan(plan, signal);
      } catch (err) {
        throw new Error(`Preflight failed before mutating files.
${err?.message ?? String(err)}`);
      }
      const details = await applyPlan(plan, signal);
      return { content: [{ type: "text", text: formatSummary(details) }], details };
    },
    renderCall(args, theme, context) {
      const component = getUnifiedEditCallRenderComponent(context.state, context.lastComponent);
      const prepared = prepareUnifiedArguments(args);
      const text = prepared && typeof prepared.text === "string" ? prepared.text : void 0;
      const key = text === void 0 ? void 0 : `${context.cwd}\0${text}`;
      if (component.previewArgsKey !== key) {
        component.preview = void 0;
        component.previewArgsKey = key;
        component.previewBuiltFromCompleteArgs = false;
        component.previewPending = false;
        component.previewPendingArgsKey = void 0;
        component.previewSuppressedArgsKey = void 0;
        component.settledError = false;
      }
      requestUnifiedEditPreview(component, text, key, context.cwd, context.argsComplete, () => context.invalidate());
      return buildUnifiedEditCallComponent(component, text, theme, context.cwd);
    },
    renderResult(result, _options, theme, context) {
      const typed = result;
      const component = context.state.callComponent;
      const prepared = prepareUnifiedArguments(context.args);
      const text = prepared && typeof prepared.text === "string" ? prepared.text : void 0;
      const key = text === void 0 ? void 0 : `${context.cwd}\0${text}`;
      let changed = false;
      if (component) {
        if (!context.isError && typed.details?.diff) {
          changed = setUnifiedEditPreview(
            component,
            {
              diff: typed.details.diff,
              files: uniquePaths(typed.details.files.map((file) => file.path)),
              firstChangedLine: typed.details.firstChangedLine
            },
            key
          ) || changed;
        }
        if (component.settledError !== context.isError) {
          component.settledError = context.isError;
          changed = true;
        }
        if (changed) buildUnifiedEditCallComponent(component, text, theme, context.cwd);
      }
      const output = formatUnifiedEditResult(component?.preview, typed, theme, context.isError);
      const resultComponent = context.lastComponent ?? new Container();
      resultComponent.clear();
      if (!output) return resultComponent;
      resultComponent.addChild(new Spacer(1));
      resultComponent.addChild(new Text(output, 1, 0));
      return resultComponent;
    }
  });
}
export {
  unifiedEditExtension as default
};
//# sourceMappingURL=unified-edit.js.map
