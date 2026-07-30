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
 *     `herdr agent prompt` / `herdr agent attach <agent>`. Otherwise falls back
 *     to the original tmux-backed mode. Results auto-inject when complete,
 *     same watcher pattern in both.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { existsSync, writeFileSync, createWriteStream, unlinkSync, type WriteStream } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  buildActivityTrail,
  formatFailureBody,
  formatToolCall,
  type ToolCallEvent,
} from "./subagent-diagnostics.js";
import {
  assertHerdrInteractiveEnv,
  attachHint,
  backendLabel,
  formatHerdrResultMessage,
  formatTmuxResultMessage,
  frameInteractiveTask,
  interactiveResultPaths,
  isInteractiveAlive,
  killInteractive,
  readHerdrRecentOutput,
  spawnHerdrInteractivePane,
  spawnTmuxInteractivePane,
  watchInteractiveResult,
  type InteractiveBackend,
} from "./subagent-interactive.js";
import { uniqueLabel } from "./subagent-naming.js";
import {
  SUBAGENT_SESSION_DIR,
  deleteSubagentSessionFile,
  ensureSubagentSessionDir,
  listSubagentSessionFiles,
  relativeTime,
  stableSubagentSessionId,
} from "./subagent-sessions.js";

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
  messages: Message[];
  usage: Usage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  lastToolCall?: string;
  proc?: ChildProcess;
  subagentSessionId?: string;
  backend?: InteractiveBackend;
  resultFile?: string;
  watcher?: ReturnType<typeof setInterval>;
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

function frameBackgroundTask(task: string): string {
  return [
    "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents — do all the work yourself directly.",
    "",
    task,
  ].join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const active = new Map<string, TrackedRun>();
  let widgetCtx: any = null;

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

  function killRun(run: TrackedRun, reason: "killed" | "timeout"): void {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.watcher) clearInterval(run.watcher);

    if (run.mode === "background" && run.proc) {
      try { run.proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { run.proc?.kill("SIGKILL"); } catch {} }, 5000);
    }

    if (run.mode === "interactive" && run.backend) {
      killInteractive(run.backend);
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

  function spawnBackground(id: string, task: string, cwd: string): TrackedRun {
    const run: TrackedRun = {
      id,
      task,
      mode: "background",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
    };

    const sessionId = stableSubagentSessionId(id);
    run.subagentSessionId = sessionId;
    ensureSubagentSessionDir();
    const piArgs: string[] = [
      "--mode", "json", "-p",
      "--session-id", sessionId,
      "--session-dir", SUBAGENT_SESSION_DIR,
      frameBackgroundTask(task),
    ];
    const invocation = getPiInvocation(piArgs);

    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    run.proc = proc;

    const eventsPath = `/tmp/subagent-${id}-events.jsonl`;
    let eventStream: WriteStream | undefined;
    try {
      eventStream = createWriteStream(eventsPath, { flags: "w" });
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

      try { eventStream?.end(); } catch {}

      const elapsed = elapsedStr(run.startTime, run.finishedAt);
      const output = getFinalText(run.messages);
      const isError =
        run.exitCode !== 0 ||
        run.signal !== undefined ||
        run.stopReason === "error" ||
        run.stopReason === "aborted";

      const resultPath = `/tmp/subagent-${id}-result.md`;
      try { writeFileSync(resultPath, output || "(no output)"); } catch {}

      if (!isError && run.subagentSessionId) {
        deleteSubagentSessionFile(run.subagentSessionId);
      }

      const usageStr = formatUsage(run.usage, run.model);
      let content: string;
      if (isError) {
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
        const footer = eventStream
          ? `_Post-mortem: \`jq . < ${eventsPath}\`_`
          : "";
        content = `## Subagent \`${id}\` failed (${elapsed})\n\n${body}${footer ? `\n\n${footer}` : ""}`;
      } else {
        content = `## Subagent \`${id}\` completed (${elapsed}, ${usageStr})\n\n${output}`;
      }

      active.delete(id);
      updateWidget();
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
      if (signal) run.signal = signal;
      finishRun(code ?? 0);
    });

    proc.on("error", () => {
      run.errorMessage = "Failed to spawn pi process";
      finishRun(1);
    });

    proc.unref();
    return run;
  }

  function settleInteractiveRun(run: TrackedRun): void {
    if (run.timeoutTimer) { clearTimeout(run.timeoutTimer); run.timeoutTimer = undefined; }
    if (run.watcher) clearInterval(run.watcher);
    active.delete(run.id);
    updateWidget();
  }

  function injectInteractiveResult(
    run: TrackedRun,
    content: string,
    promptFile?: string,
  ): void {
    settleInteractiveRun(run);
    pi.sendMessage(
      { customType: "subagent-result", content, display: true },
      { triggerTurn: true, deliverAs: "followUp" }
    );
    if (promptFile) unlink(promptFile).catch(() => {});
  }

  function startInteractiveWatcher(
    run: TrackedRun,
    injectResult: () => void | Promise<void>,
  ): void {
    run.watcher = watchInteractiveResult({
      resultFile: run.resultFile!,
      isAlive: () => isInteractiveAlive(run.backend!),
      injectResult,
      onWatcherClear: () => {
        if (run.watcher) clearInterval(run.watcher);
      },
    });
  }

  function spawnInteractiveTmux(id: string, task: string, cwd: string): TrackedRun {
    const tabLabel = uniqueLabel(task, id);
    const { resultFile, promptFile, errLog } = interactiveResultPaths(id);
    const framedTask = frameInteractiveTask(task, resultFile, "tmux");

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      resultFile,
    };

    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        content = formatTmuxResultMessage(id, elapsed, result, false);
      } catch {
        let errMsg = "";
        try { errMsg = await readFile(errLog, "utf8"); } catch {}
        content = formatTmuxResultMessage(id, elapsed, "", true, errMsg);
      }
      injectInteractiveResult(run, content, promptFile);
    };

    run.backend = spawnTmuxInteractivePane({
      tabLabel,
      cwd,
      framedTask,
      promptFile,
      onPasteFailed: injectResult,
    });

    startInteractiveWatcher(run, injectResult);
    return run;
  }

  function spawnInteractiveHerdr(id: string, task: string, cwd: string): TrackedRun {
    const parentPane = assertHerdrInteractiveEnv();
    const tabLabel = uniqueLabel(task, id);
    const { resultFile } = interactiveResultPaths(id);
    const framedTask = frameInteractiveTask(task, resultFile, "herdr");

    const run: TrackedRun = {
      id,
      task,
      mode: "interactive",
      startTime: Date.now(),
      messages: [],
      usage: emptyUsage(),
      resultFile,
    };

    const injectResult = async () => {
      const elapsed = elapsedStr(run.startTime);
      const backend = run.backend!;
      const agentName = backend.kind === "herdr" ? backend.agent : tabLabel;
      let content: string;
      try {
        const result = await readFile(resultFile, "utf8");
        content = formatHerdrResultMessage(id, tabLabel, agentName, elapsed, result, false);
      } catch {
        const paneId = backend.kind === "herdr" ? backend.pane : "";
        const errMsg = paneId ? readHerdrRecentOutput(paneId) : "";
        content = formatHerdrResultMessage(id, tabLabel, agentName, elapsed, "", true, errMsg);
      }
      injectInteractiveResult(run, content);
    };

    run.backend = spawnHerdrInteractivePane({
      tabLabel,
      cwd,
      parentPane,
      framedTask,
    });

    startInteractiveWatcher(run, injectResult);
    return run;
  }

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

  pi.on("turn_start", async (_event, ctx) => {
    widgetCtx = ctx;
  });

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
      widgetCtx = ctx;

      if (active.has(id)) {
        throw new Error(`Subagent '${id}' is already running. Use a different ID or wait for it to finish.`);
      }

      const timeoutMs = (timeout || 10) * 60_000;

      if (interactive) {
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

        const backend = run.backend!;
        const labelTxt = backend.tabLabel ? ` “${backend.tabLabel}”` : "";
        return {
          content: [{
            type: "text" as const,
            text: `Subagent '${id}'${labelTxt} spawned in ${backendLabel(backend)}. Switch to it:\n  ${attachHint(backend)}\nResults will auto-inject when complete.`,
          }],
          details: {
            id,
            mode: "interactive",
            backend: backend.kind,
            tabLabel: backend.tabLabel,
            cwd,
          },
        };
      }

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

      const lines = Array.from(active.entries()).map(([id, run]) => {
        const elapsed = elapsedStr(run.startTime);
        const mode = run.mode === "interactive"
          ? (run.backend?.kind === "herdr" ? "herdr" : "tmux")
          : "bg";
        const activity = run.lastToolCall ? ` — ${run.lastToolCall}` : "";
        const usage = run.usage.turns > 0 ? ` [${formatUsage(run.usage)}]` : "";
        const label = run.backend?.tabLabel ? ` “${run.backend.tabLabel}”` : "";
        const attach = run.backend
          ? ` — \`${attachHint(run.backend)}\``
          : "";
        return `- **${id}**${label} [${mode}] ${elapsed}${activity}${usage}${attach}`;
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
          `- ${basename(f.file)}  (${relativeTime(f.mtime)})`);
        ctx.ui.notify(`Crashed subagent sessions:\n${lines.join("\n")}`, "info");
        return;
      }

      const files = listSubagentSessionFiles();
      if (files.length === 0) {
        ctx.ui.notify("No crashed subagent sessions to resume (clean runs delete their own files).", "info");
        return;
      }

      const options = files.map((f) => `${basename(f.file)}  (${relativeTime(f.mtime)})`);
      const choice = await ctx.ui.select("Resume a crashed subagent session:", options);
      if (!choice) return;

      const idx = options.indexOf(choice);
      if (idx < 0) return;
      const selected = files[idx];

      await ctx.switchSession(selected.file, {
        withSession: async (newCtx) => {
          newCtx.ui.notify("Switched into crashed subagent session — continue from here.", "info");
        },
      });
    },
  });
}
