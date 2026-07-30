/**
 * Subagent Extension — fire-and-forget with streaming progress.
 *
 * Two modes:
 *   - background (default): Spawns `pi --mode json -p` with a per-task
 *     --session-id + --session-dir so the run is durable. Returns immediately.
 *     Parses JSON events in background for live widget updates. Injects result
 *     via sendMessage when done. On clean exit the session file is deleted; on
 *     crash/kill/credits-death it survives and is recoverable via /resume-subagent.
 *   - interactive: Full pi in a real pane you can steer. When pi is running
 *     inside herdr (HERDR_ENV=1), spawns into a new herdr pane via `herdr pane
 *     split` + `herdr agent start --kind pi --pane <id>` — steer it with
 *     `herdr agent prompt` / `herdr agent attach <pane>`. Otherwise falls back
 *     to the original tmux-backed mode. Results auto-inject when complete,
 *     same watcher pattern in both.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFile, readFile, unlink, access } from "node:fs/promises";
import { existsSync, writeFileSync, createWriteStream, mkdirSync, unlinkSync, readdirSync, statSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  buildActivityTrail,
  formatFailureBody,
  formatToolCall,
  type ToolCallEvent,
} from "./subagent-diagnostics.js";

// ── Types ──────────────────────────────────────────────────────────────

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface TrackedRun {
  id: string;
  task: string;
  mode: "background" | "interactive";
  startTime: number;
  finishedAt?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  // Background-only streaming state
  messages: Message[];
  usage: Usage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  lastToolCall?: string;
  proc?: ChildProcess;
  // Durability: stable session id used for --session-id; file is deleted on clean exit.
  subagentSessionId?: string;
  // Interactive-only: attach hint for whichever backend this run uses.
  // tmuxSession for the tmux path; herdrPane for the herdr path. The widget /
  // status / kill logic branch on whichever is set.
  tmuxSession?: string;
  herdrPane?: string;
  resultFile?: string;
  watcher?: ReturnType<typeof setInterval>;
  // Timeout
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: Usage, model?: string): string {
  const p: string[] = [];
  if (u.turns) p.push(`${u.turns}t`);
  if (u.input) p.push(`↑${formatTokens(u.input)}`);
  if (u.output) p.push(`↓${formatTokens(u.output)}`);
  if (u.cost) p.push(`$${u.cost.toFixed(3)}`);
  if (model) p.push(model);
  return p.join(" ");
}

function getFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      // Concatenate ALL text parts — pi emits multiple text parts per message
      // (e.g. a whitespace separator after thinking, then the actual content).
      // Returning only the first text part often yields just "\n\n".
      const texts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text") texts.push(part.text);
      }
      if (texts.length > 0) return texts.join("").trim();
    }
  }
  return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function elapsedStr(start: number, end?: number): string {
  const s = ((end || Date.now()) - start) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}m`;
}

// ── Durability: per-task session persistence for crash recovery ──────
// Background subagents run with --session-id <stable> --session-dir <dir> so
// each run's full transcript is persisted to disk. On clean exit the file is
// deleted; on crash / kill / credits-death it survives, and /resume-subagent
// can switch the parent session back into it to continue the work.

const SUBAGENT_SESSION_DIR = join(homedir(), ".pi", "agent", "subagent-sessions");

function ensureSubagentSessionDir(): void {
  if (!existsSync(SUBAGENT_SESSION_DIR)) {
    mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
  }
}

function stableSubagentSessionId(id: string): string {
  return `subagent-${id}-${randomBytes(4).toString("hex")}`;
}

function deleteSubagentSessionFile(sessionId: string): void {
  try {
    for (const f of readdirSync(SUBAGENT_SESSION_DIR)) {
      if (f.endsWith(`_${sessionId}.jsonl`)) {
        unlinkSync(join(SUBAGENT_SESSION_DIR, f));
      }
    }
  } catch {}
}

function listSubagentSessionFiles(): { file: string; mtime: number }[] {
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

function relativeTime(ms: number): string {
  const ago = Date.now() - ms;
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const active = new Map<string, TrackedRun>();
  let widgetCtx: any = null; // stash ctx for widget updates

  // ── Widget: live status of all running subagents ──

  function updateWidget() {
    if (!widgetCtx) return;
    const running = [...active.values()].filter((r) => r.exitCode === undefined);
    if (running.length === 0) {
      widgetCtx.ui.setWidget("subagent-status", undefined);
      return;
    }

    widgetCtx.ui.setWidget("subagent-status", (_tui: any, theme: any) => {
      const lines = running.map((r) => {
        const elapsed = elapsedStr(r.startTime);
        const icon = r.mode === "interactive" ? "🖥" : "⏳";
        const activity = r.lastToolCall
          ? theme.fg("dim", ` → ${r.lastToolCall}`)
          : theme.fg("dim", " starting…");
        const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
        return `${icon} ${theme.fg("accent", r.id)} ${theme.fg("dim", elapsed)}${activity}${usage}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    });
  }

  // ── Kill/cleanup helper ──

  function killRun(run: TrackedRun, reason: "killed" | "timeout"): void {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.watcher) clearInterval(run.watcher);

    if (run.mode === "background" && run.proc) {
      try { run.proc.kill("SIGTERM"); } catch {}
      // Force kill after 5s if still alive
      setTimeout(() => { try { run.proc?.kill("SIGKILL"); } catch {} }, 5000);
    }

    if (run.mode === "interactive" && run.tmuxSession) {
      try {
        execFileSync("tmux", ["send-keys", "-t", run.tmuxSession, "C-c", ""], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", run.tmuxSession, "exit", "Enter"], { stdio: "ignore" });
      } catch {}
    }

    if (run.mode === "interactive" && run.herdrPane) {
      // Abort pi's current turn (Escape), then close the pane. Symmetric with
      // the tmux path which sends C-c + exit. Closing the pane is the right
      // move on timeout/kill (subagent is unresponsive / cancelled); on clean
      // completion the watcher leaves the pane open for the user to steer.
      try {
        execFileSync("herdr", ["agent", "send-keys", run.herdrPane, "esc", "C-c"], { stdio: "ignore" });
      } catch {}
      try {
        execFileSync("herdr", ["pane", "close", run.herdrPane], { stdio: "ignore" });
      } catch {}
    }

    run.exitCode = reason === "timeout" ? 124 : 130;
    run.finishedAt = Date.now();
    const elapsed = elapsedStr(run.startTime, run.finishedAt);
    active.delete(run.id);
    updateWidget();

    const label = reason === "timeout"
      ? `timed out after ${Math.round((run.timeoutMs || 0) / 60000)}min`
      : "killed by user";

    pi.sendMessage(
      {
        customType: "subagent-result",
        content: `## Subagent \`${run.id}\` ${label} (${elapsed})\n\nThe subagent was ${label}.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }

  // ── Background mode: fire-and-forget with JSON streaming ──

  function spawnBackground(
    id: string,
    task: string,
    cwd: string,
  ): TrackedRun {
    const run: TrackedRun = {
      id,
      task,
      mode: "background",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
    };

    // Prepend instruction to prevent nested subagent spawning
    const framedTask = [
      "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents — do all the work yourself directly.",
      "",
      task,
    ].join("\n");
    const sessionId = stableSubagentSessionId(id);
    run.subagentSessionId = sessionId;
    ensureSubagentSessionDir();
    // Persist this run to a dedicated session dir so a crash / kill / credits-death
    // is recoverable via /resume-subagent. File is deleted on clean exit below.
    const piArgs: string[] = [
      "--mode", "json", "-p",
      "--session-id", sessionId,
      "--session-dir", SUBAGENT_SESSION_DIR,
      framedTask,
    ];
    const invocation = getPiInvocation(piArgs);

    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.proc = proc;

    // Mirror the raw JSON event stream to /tmp for post-mortem analysis.
    // Unlike result.md (final assistant text only) and err.log (stderr only),
    // this captures every event pi emitted — tool calls, tool results,
    // thinking blocks, message deltas. Essential when a subagent fails mid-run:
    // `jq . < /tmp/subagent-<id>-events.jsonl` reconstructs what it was doing.
    const eventsPath = `/tmp/subagent-${id}-events.jsonl`;
    let eventStream: WriteStream | undefined;
    try {
      eventStream = createWriteStream(eventsPath, { flags: "w" });
      // Swallow stream errors — a failure to write the post-mortem log should
      // never cascade into the subagent's own execution.
      eventStream.on("error", () => {
        try { eventStream?.destroy(); } catch {}
        eventStream = undefined;
      });
    } catch {
      eventStream = undefined;
    }

    let buffer = "";
    let stderr = "";
    let completed = false;

    const finishRun = (code: number) => {
      if (completed) return;
      if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
      completed = true;
      if (buffer.trim()) processLine(buffer);
      run.exitCode = code;
      run.finishedAt = Date.now();

      // Flush + close the post-mortem event log (best-effort).
      try { eventStream?.end(); } catch {}

      const elapsed = elapsedStr(run.startTime, run.finishedAt);
      const output = getFinalText(run.messages);
      // A signal-only kill (`code === null` in proc.close, captured into
      // run.signal) without a preceding error/aborted turn_end previously
      // routed through the "completed" branch — defeating the whole point of
      // capturing the signal. Including `run.signal` here ensures signal-killed
      // subagents always surface through formatFailureBody with the signal field.
      const isError =
        run.exitCode !== 0 ||
        run.signal !== undefined ||
        run.stopReason === "error" ||
        run.stopReason === "aborted";

      // Write result file for interop
      const resultPath = `/tmp/subagent-${id}-result.md`;
      try { writeFileSync(resultPath, output || "(no output)"); } catch {}

      // Durability: on clean exit, delete the per-task session file so only
      // crashed/killed/credits-dead runs survive for /resume-subagent.
      if (!isError && run.subagentSessionId) {
        deleteSubagentSessionFile(run.subagentSessionId);
      }

      // Build injection message
      const usageStr = formatUsage(run.usage, run.model);
      let content: string;
      if (isError) {
        // Harvest the full tool-call trail from the subagent's assistant
        // messages. The extension already tracks `run.lastToolCall` for the
        // widget; the failure body gets the complete (capped) trail so the
        // parent agent can decide its next move without opening events.jsonl.
        const events: ToolCallEvent[] = [];
        for (const msg of run.messages) {
          if (msg.role !== "assistant") continue;
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              events.push({
                name: part.name,
                arguments: part.arguments as Record<string, unknown>,
              });
            }
          }
        }
        const activityTrail = buildActivityTrail(events, {
          eventsFile: eventStream ? eventsPath : undefined,
        });
        const body = formatFailureBody({
          errorMessage: run.errorMessage,
          stopReason: run.stopReason,
          exitCode: run.exitCode,
          signal: run.signal,
          stderr,
          activityTrail,
          usageLine: run.usage.turns > 0 ? usageStr : undefined,
          partialOutput: output,
        });
        // Only point at the events file if the stream was successfully opened.
        const footer = eventStream
          ? `_Post-mortem: \`jq . < ${eventsPath}\`_`
          : "";
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${body}${footer ? `\n\n${footer}` : ""}`;
      } else {
        content = `## Subagent \`${id}\` completed (${elapsed}, ${usageStr})\n\n${output}`;
      }

      active.delete(id);
      updateWidget();

      // Kill the process if it's still hanging around
      try { proc.kill(); } catch {}

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }

      // agent_end or a turn_end with no pending tool calls means the run
      // is complete — don't wait for process close (pi --mode json -p can
      // hang in extension shutdown for minutes).
      if (event.type === "agent_end") {
        finishRun(0);
        return;
      }
      if (event.type === "turn_end" && event.message) {
        const msg = event.message as AssistantMessage;
        const hasToolCall = Array.isArray(msg.content) && msg.content.some((p: any) => p.type === "toolCall");
        const errored = msg.stopReason === "error" || msg.stopReason === "aborted";
        if (!hasToolCall && !errored) {
          finishRun(0);
          return;
        }
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        run.messages.push(msg);
        if (msg.role === "assistant") {
          run.usage.turns++;
          const u = msg.usage;
          if (u) {
            run.usage.input += u.input || 0;
            run.usage.output += u.output || 0;
            run.usage.cacheRead += u.cacheRead || 0;
            run.usage.cacheWrite += u.cacheWrite || 0;
            run.usage.cost += u.cost?.total || 0;
          }
          if (!run.model && msg.model) run.model = msg.model;
          if (msg.stopReason) run.stopReason = msg.stopReason;
          if (msg.errorMessage) run.errorMessage = msg.errorMessage;

          // Track latest tool call for widget display
          for (const part of msg.content) {
            if (part.type === "toolCall") {
              run.lastToolCall = formatToolCall(
                { name: part.name, arguments: part.arguments as Record<string, unknown> },
                { maxLineChars: 80, pathStyle: "collapsed", format: "widget" },
              );
            }
          }
        }
        updateWidget();
      }

      if (event.type === "tool_result_end" && event.message) {
        run.messages.push(event.message as Message);
        updateWidget();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      try { eventStream?.write(data); } catch {}
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code, signal) => {
      // finishRun is idempotent — may have already been called via agent_end
      if (signal) run.signal = signal;
      finishRun(code ?? 0);
    });

    proc.on("error", () => {
      run.errorMessage = "Failed to spawn pi process";
      finishRun(1);
    });

    // Don't keep parent alive waiting for child
    proc.unref();
    return run;
  }

  // ── Interactive mode: tmux ──
  // Fallback backend when pi is not running inside herdr. Keeps the original
  // tmux-based paste-buffer + watcher flow for non-herdr users.

  function isTmuxTargetAlive(target: string): boolean {
    try {
      execFileSync("tmux", ["display-message", "-t", target, "-p", ""], { stdio: "ignore" });
      return true;
    } catch { return false; }
  }

  function spawnInteractiveTmux(id: string, task: string, cwd: string): TrackedRun {
    const tmuxName = `subagent-${id}`;
    const resultFile = `/tmp/subagent-${id}-result.md`;
    const promptFile = `/tmp/subagent-${id}-prompt.md`;

    let parentSession = "";
    try {
      parentSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"],
        { encoding: "utf8" }).trim();
    } catch {}

    let pasteTarget: string;

    if (parentSession) {
      pasteTarget = `${parentSession}:${tmuxName}`;
      execFileSync("tmux", [
        "new-window", "-t", parentSession, "-n", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
    } else {
      pasteTarget = tmuxName;
      execFileSync("tmux", [
        "new-session", "-d", "-s", tmuxName, "-c", cwd, "pi",
      ], { stdio: "ignore" });
      try {
        execFileSync("tmux", ["resize-window", "-t", tmuxName, "-x", "200", "-y", "50"],
          { stdio: "ignore" });
      } catch {}
    }

    const framedTask = `${task}

When you have completed the task, do these two things:
1. Use the write tool to save your complete findings/summary to ${resultFile}
2. Then say "SUBAGENT COMPLETE" so I know you're done.`;

    const maxWaitMs = 30_000;
    const waitStart = Date.now();
    const readyPoller = setInterval(() => {
      try {
        const pane = execFileSync("tmux", ["capture-pane", "-t", pasteTarget, "-p"],
          { encoding: "utf8" });
        const ready = /\$\d+\.\d+/.test(pane);
        if (!ready && Date.now() - waitStart < maxWaitMs) return;

        clearInterval(readyPoller);
        writeFileSync(promptFile, framedTask);
        const bufferName = `${tmuxName}-prompt`;
        execFileSync("tmux", ["load-buffer", "-b", bufferName, promptFile], { stdio: "ignore" });
        execFileSync("tmux", ["paste-buffer", "-dp", "-b", bufferName, "-t", pasteTarget], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", pasteTarget, "Enter"], { stdio: "ignore" });
      } catch {
        if (Date.now() - waitStart >= maxWaitMs) {
          clearInterval(readyPoller);
          // Paste failed after max wait — trigger cleanup to avoid watcher leak
          injectResult();
        }
      }
    }, 1000);

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      tmuxSession: pasteTarget,
      resultFile,
    };

    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
      if (run.watcher) clearInterval(run.watcher);
      active.delete(id);
      updateWidget();

      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        content = `## Subagent \`${id}\` completed (${elapsed})\n\n${result}`;
      } catch {
        let errMsg = "";
        try { errMsg = await readFile(`/tmp/subagent-${id}-err.log`, "utf8"); } catch {}
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${errMsg || "No output."}`;
      }

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
      unlink(`/tmp/subagent-${id}-prompt.md`).catch(() => {});
    };

    run.watcher = setInterval(async () => {
      const alive = isTmuxTargetAlive(pasteTarget);
      let resultExists = false;
      try { await access(resultFile); resultExists = true; } catch {}

      if (resultExists) {
        if (alive) {
          setTimeout(() => injectResult(), 3000);
          if (run.watcher) clearInterval(run.watcher);
        } else {
          injectResult();
        }
      } else if (!alive) {
        injectResult();
      }
    }, 5000);

    return run;
  }

  // ── Interactive mode: herdr ──
  // Preferred backend when pi runs inside herdr (HERDR_ENV=1). Splits a new
  // pane off the parent, starts pi in it via `herdr agent start --kind pi`, and
  // watches the same resultFile as the tmux path. The pane stays open on
  // clean completion so the user can `herdr agent attach <pane>` to steer.

  function isHerdrPaneAlive(paneId: string): boolean {
    try {
      execFileSync("herdr", ["pane", "get", paneId], { stdio: "ignore" });
      return true;
    } catch { return false; }
  }

  function spawnInteractiveHerdr(id: string, task: string, cwd: string): TrackedRun {
    const parentPane = process.env.HERDR_PANE_ID;
    if (!parentPane || process.env.HERDR_ENV !== "1") {
      throw new Error("herdr interactive mode requires pi to be running inside a herdr pane (HERDR_ENV=1 + HERDR_PANE_ID). Use background mode or run pi inside herdr.");
    }

    // 1. Split a new pane to the right of the parent, same cwd.
    let paneId: string;
    try {
      const raw = execFileSync("herdr", [
        "pane", "split",
        "--pane", parentPane,
        "--direction", "right",
        "--cwd", cwd,
      ], { encoding: "utf8" });
      const parsed = JSON.parse(raw);
      paneId = parsed?.result?.pane?.pane_id;
      if (!paneId) throw new Error("herdr pane split returned no pane_id");
    } catch (e: any) {
      throw new Error(`herdr pane split failed: ${e?.message || e}`);
    }

    const resultFile = `/tmp/subagent-${id}-result.md`;

    // 2. Start a pi agent in the new pane and pass the framed task as ARGV so
    //    pi runs it immediately (no paste-buffer dance). `herdr agent start`
    //    waits for interactive readiness before returning.
    const framedTask = [
      "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents — do all the work yourself directly.",
      "",
      task,
      "",
      `When you have completed the task, do these two things:`,
      `1. Use the write tool to save your complete findings/summary to ${resultFile}`,
      `2. Then say "SUBAGENT COMPLETE" so I know you're done.`,
    ].join("\n");

    const agentName = `subagent-${id}`;
    try {
      execFileSync("herdr", [
        "agent", "start", agentName,
        "--kind", "pi",
        "--pane", paneId,
        "--", framedTask,
      ], { stdio: "ignore" });
    } catch (e: any) {
      // Clean up the orphan pane we created so a failed start doesn't leak.
      try { execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch {}
      throw new Error(`herdr agent start failed: ${e?.message || e}`);
    }

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      herdrPane: paneId,
      resultFile,
    };

    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
      if (run.watcher) clearInterval(run.watcher);
      active.delete(id);
      updateWidget();

      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        // Pane intentionally left open after clean completion so the user can
        // steer / inspect. Tell them how to jump in.
        content = `## Subagent \`${id}\` completed (${elapsed})\n\n${result}\n\n_Steer it: \`herdr agent attach ${paneId}\` — pane left open._`;
      } catch {
        // No result file → failure. Capture recent terminal output so the
        // failure body has useful context (same idea as the background path's
        // events.jsonl post-mortem).
        let errMsg = "";
        try {
          errMsg = execFileSync("herdr",
            ["agent", "read", paneId, "--source", "recent", "--lines", "20"],
            { encoding: "utf8" }) || "";
        } catch {}
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${errMsg || "No output. Pane may have been closed or pi failed to start."}`;
      }

      pi.sendMessage(
        { customType: "subagent-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    };

    run.watcher = setInterval(async () => {
      const alive = isHerdrPaneAlive(paneId);
      let resultExists = false;
      try { await access(resultFile); resultExists = true; } catch {}

      if (resultExists) {
        if (alive) {
          // Give pi a moment to finish printing SUBAGENT COMPLETE before we inject.
          setTimeout(() => injectResult(), 3000);
          if (run.watcher) clearInterval(run.watcher);
        } else {
          injectResult();
        }
      } else if (!alive) {
        // Pane died with no result file → pi crashed / was closed mid-task.
        injectResult();
      }
    }, 5000);

    return run;
  }

  // ── Lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    widgetCtx = ctx;
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    active.clear();
  });

  pi.on("session_shutdown", async () => {
    for (const [, entry] of active) {
      if (entry.watcher) clearInterval(entry.watcher);
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    }
    widgetCtx = null;
  });

  // Stash ctx from agent turns so widget works
  pi.on("turn_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });

  // ── Tools ──

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a background pi subagent to work on a task. " +
      "Returns immediately — the subagent runs in the background with full tool access. " +
      "Live progress shown in a widget. Results auto-inject when complete. " +
      "Use for research, analysis, code review, data gathering — anything that can run independently.",
    promptSnippet: "Spawn background pi subagent — results auto-inject when done",
    promptGuidelines: [
      "Use subagent for independent tasks (research, analysis, review) that don't need user interaction",
      "Keep subagent tasks focused and self-contained — include all context the subagent needs",
      "Use short descriptive IDs like 'cr-review', 'coverage', 'pipeline-check'",
      "Max 3-4 concurrent subagents to avoid rate limits",
      "Subagent results arrive as messages — you'll get a turn to incorporate them",
      "Interactive mode spawns pi in a steerable pane — in herdr (if pi runs inside it) or in a tmux window otherwise. Results still auto-inject when done.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "Short descriptive ID for this subagent (e.g. 'cr-review', 'coverage-check', 'error-research')",
      }),
      task: Type.String({
        description: "Detailed task description. Be specific — include file paths, URLs, criteria. The subagent has full tool access.",
      }),
      workingDir: Type.Optional(
        Type.String({ description: "Working directory for the subagent (default: current directory)" })
      ),
      interactive: Type.Optional(
        Type.Boolean({
          description: "If true, spawns a full interactive pi session the user can steer. Uses herdr when pi runs inside it (HERDR_ENV=1), else tmux. Default: false (background pi -p).",
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in minutes. Subagent is auto-killed when exceeded. Default: 10.",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { id, task, interactive, timeout } = params;
      const cwd = params.workingDir || ctx.cwd;
      widgetCtx = ctx; // ensure widget works

      if (active.has(id)) {
        throw new Error(`Subagent '${id}' is already running. Use a different ID or wait for it to finish.`);
      }

      const timeoutMs = (timeout || 10) * 60_000;

      if (interactive) {
        // Pick the backend by proximity: herdr when pi is running inside it,
        // otherwise the original tmux path. Both share the resultFile watcher.
        const inHerdr = process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
        if (!inHerdr) {
          try {
            execFileSync("tmux", ["-V"], { stdio: "ignore" });
          } catch {
            throw new Error(
              "interactive mode needs herdr or tmux; retry with interactive:false for a background subagent."
            );
          }
        }
        const run = inHerdr
          ? spawnInteractiveHerdr(id, task, cwd)
          : spawnInteractiveTmux(id, task, cwd);
        run.timeoutMs = timeoutMs;
        run.timeoutTimer = setTimeout(() => killRun(run, "timeout"), timeoutMs);
        active.set(id, run);
        updateWidget();

        const backend = run.tmuxSession ? "tmux window" : "herdr pane";
        const attach = run.tmuxSession
          ? `tmux select-window -t ${run.tmuxSession}`
          : `herdr agent attach ${run.herdrPane}`;
        return {
          content: [{
            type: "text" as const,
            text: `Subagent '${id}' spawned in ${backend}. Switch to it:\n  ${attach}\nResults will auto-inject when complete.`,
          }],
          details: { id, mode: "interactive", tmuxSession: run.tmuxSession, herdrPane: run.herdrPane, cwd },
        };
      }

      // Background mode — fire and forget
      const run = spawnBackground(id, task, cwd);
      run.timeoutMs = timeoutMs;
      run.timeoutTimer = setTimeout(() => killRun(run, "timeout"), timeoutMs);
      active.set(id, run);
      updateWidget();

      return {
        content: [{
          type: "text" as const,
          text: `Subagent '${id}' spawned in background. Live progress in widget above. Results will auto-inject when complete.`,
        }],
        details: { id, mode: "background", cwd },
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Check the status of running subagents",
    promptSnippet: "Check running subagent status",
    parameters: Type.Object({}),

    async execute() {
      if (active.size === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagents currently running." }],
          details: { count: 0 as number, ids: [] as string[] },
        };
      }

      const now = Date.now();
      const lines = Array.from(active.entries()).map(([id, run]) => {
        const elapsed = elapsedStr(run.startTime);
        const mode = run.mode === "interactive"
          ? (run.herdrPane ? "herdr" : "tmux")
          : "bg";
        const activity = run.lastToolCall ? ` — ${run.lastToolCall}` : "";
        const usage = run.usage.turns > 0 ? ` [${formatUsage(run.usage)}]` : "";
        const attach = run.tmuxSession
          ? ` — \`tmux select-window -t ${run.tmuxSession}\``
          : run.herdrPane
          ? ` — \`herdr agent attach ${run.herdrPane}\``
          : "";
        return `- **${id}** [${mode}] ${elapsed}${activity}${usage}${attach}`;
      });

      return {
        content: [{
          type: "text" as const,
          text: `**${active.size} subagent(s) running:**\n${lines.join("\n")}`,
        }],
        details: { count: active.size, ids: Array.from(active.keys()) },
      };
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description: "Terminate a running subagent by ID",
    promptSnippet: "Kill a running subagent",
    parameters: Type.Object({
      id: Type.String({
        description: "ID of the subagent to kill",
      }),
    }),

    async execute(_toolCallId, params) {
      const { id } = params;
      const run = active.get(id);
      if (!run) {
        throw new Error(`No subagent with ID '${id}' found. It may have already completed.`);
      }
      if (run.exitCode !== undefined) {
        throw new Error(`Subagent '${id}' has already finished.`);
      }

      killRun(run, "killed");

      return {
        content: [{
          type: "text" as const,
          text: `Subagent '${id}' has been killed.`,
        }],
        details: { id, killed: true },
      };
    },
  });

  // ── /resume-subagent: recover crashed / killed / credits-dead subagents ──
  // A clean background exit deletes its session file, so anything left in
  // SUBAGENT_SESSION_DIR is by definition a run that didn't finish cleanly.
  // This command lists those survivors and switches the current session into
  // the chosen one (same mechanism as /handoff), so the parent agent picks up
  // exactly where the dead subagent left off.
  pi.registerCommand("resume-subagent", {
    description: "Resume a crashed/killed subagent session, or purge saved crash files",
    handler: async (args, ctx) => {
      const arg = (args || "").trim();

      if (arg === "purge") {
        const files = listSubagentSessionFiles();
        let n = 0;
        for (const f of files) {
          try { unlinkSync(f.file); n++; } catch {}
        }
        ctx.ui.notify(`Purged ${n} subagent crash file${n === 1 ? "" : "s"}.`, "info");
        return;
      }

      if (arg === "list") {
        const files = listSubagentSessionFiles();
        if (files.length === 0) {
          ctx.ui.notify("No crashed subagent sessions on disk.", "info");
          return;
        }
        const lines = files.map((f) =>
          `- ${f.file.replace(SUBAGENT_SESSION_DIR + "/", "")}  (${relativeTime(f.mtime)})`);
        ctx.ui.notify(`Crashed subagent sessions:\n${lines.join("\n")}`, "info");
        return;
      }

      const files = listSubagentSessionFiles();
      if (files.length === 0) {
        ctx.ui.notify("No crashed subagent sessions to resume (clean runs delete their own files).", "info");
        return;
      }

      const options = files.map((f) => {
        const name = f.file.replace(SUBAGENT_SESSION_DIR + "/", "");
        return `${name}  (${relativeTime(f.mtime)})`;
      });
      const choice = await ctx.ui.select("Resume a crashed subagent session:", options);
      if (!choice) return;

      // choice is `<basename>  (<reltime>)`; recover the basename to build the full path.
      const basename = choice.replace(/\s+\([^)]*\)\s*$/, "");
      const fullPath = join(SUBAGENT_SESSION_DIR, basename);

      await ctx.switchSession(fullPath, {
        withSession: async (newCtx) => {
          newCtx.ui.notify("Switched into crashed subagent session — continue from here.", "info");
        },
      });
    },
  });
}
