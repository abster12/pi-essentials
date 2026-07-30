/**
 * Interactive subagent backend helpers.
 *
 * Extracted so unit tests can import pure logic without peer deps.
 * Tmux and herdr share one result watcher and a typed backend union.
 */
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { writeFileSync } from "node:fs";

export type InteractiveBackend =
  | { kind: "tmux"; target: string; tabLabel: string }
  | { kind: "herdr"; pane: string; agent: string; tabLabel: string };

/** How the framed interactive prompt is ordered per backend. */
export type InteractiveFrameStyle = "tmux" | "herdr";

const SUBAGENT_PREAMBLE =
  "IMPORTANT: You are running as a subagent. Do NOT spawn sub-subagents — do all the work yourself directly.";

function completionBlock(resultFile: string): string {
  return [
    "When you have completed the task, do these two things:",
    `1. Use the write tool to save your complete findings/summary to ${resultFile}`,
    `2. Then say "SUBAGENT COMPLETE" so I know you're done.`,
  ].join("\n");
}

/**
 * Single task-framing helper for interactive backends.
 * Herdr puts the task first so fallback title derivation (without PI_TAB_LABEL)
 * shows the work, not the subagent preamble. Tmux omits IMPORTANT — the paste
 * buffer flow doesn't need it and PI_TAB_LABEL pins the tab name anyway.
 */
export function frameInteractiveTask(
  task: string,
  resultFile: string,
  style: InteractiveFrameStyle,
): string {
  const completion = completionBlock(resultFile);
  if (style === "herdr") {
    return [task, "", SUBAGENT_PREAMBLE, "", completion].join("\n");
  }
  return `${task}\n\n${completion}`;
}

export function attachHint(backend: InteractiveBackend): string {
  switch (backend.kind) {
    case "tmux":
      return `tmux select-window -t ${backend.target}`;
    case "herdr":
      return `herdr agent attach ${backend.agent}`;
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

export function backendLabel(backend: InteractiveBackend): string {
  switch (backend.kind) {
    case "tmux":
      return "tmux window";
    case "herdr":
      return "herdr pane";
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

function isTmuxTargetAlive(target: string): boolean {
  try {
    execFileSync("tmux", ["display-message", "-t", target, "-p", ""], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isHerdrPaneAlive(paneId: string): boolean {
  try {
    execFileSync("herdr", ["pane", "get", paneId], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isInteractiveAlive(backend: InteractiveBackend): boolean {
  switch (backend.kind) {
    case "tmux":
      return isTmuxTargetAlive(backend.target);
    case "herdr":
      return isHerdrPaneAlive(backend.pane);
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

export function killInteractive(backend: InteractiveBackend): void {
  switch (backend.kind) {
    case "tmux":
      try {
        execFileSync("tmux", ["send-keys", "-t", backend.target, "C-c", ""], { stdio: "ignore" });
        execFileSync("tmux", ["send-keys", "-t", backend.target, "exit", "Enter"], { stdio: "ignore" });
      } catch {}
      break;
    case "herdr":
      // Abort pi's current turn (Escape), then close the pane. Symmetric with
      // the tmux path which sends C-c + exit.
      try {
        execFileSync("herdr", ["agent", "send-keys", backend.pane, "esc", "C-c"], { stdio: "ignore" });
      } catch {}
      try {
        execFileSync("herdr", ["pane", "close", backend.pane], { stdio: "ignore" });
      } catch {}
      break;
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

/**
 * Shared result-file watcher for tmux and herdr interactive runs.
 * Polls until a result exists and/or the pane dies, then calls injectResult.
 * Semantics: result + alive → delay then inject; result + dead → inject now;
 * dead with no result → inject failure.
 */
export function watchInteractiveResult(opts: {
  resultFile: string;
  isAlive: () => boolean;
  injectResult: () => void | Promise<void>;
  onWatcherClear?: () => void;
  pollMs?: number;
  successDelayMs?: number;
}): ReturnType<typeof setInterval> {
  const {
    resultFile,
    isAlive,
    injectResult,
    onWatcherClear,
    pollMs = 5000,
    successDelayMs = 3000,
  } = opts;

  return setInterval(async () => {
    const alive = isAlive();
    let resultExists = false;
    try {
      await access(resultFile);
      resultExists = true;
    } catch {}

    if (resultExists) {
      if (alive) {
        setTimeout(() => injectResult(), successDelayMs);
        onWatcherClear?.();
      } else {
        injectResult();
      }
    } else if (!alive) {
      injectResult();
    }
  }, pollMs);
}

export function interactiveResultPaths(id: string): {
  resultFile: string;
  promptFile: string;
  errLog: string;
} {
  return {
    resultFile: `/tmp/subagent-${id}-result.md`,
    promptFile: `/tmp/subagent-${id}-prompt.md`,
    errLog: `/tmp/subagent-${id}-err.log`,
  };
}

export function assertHerdrInteractiveEnv(): string {
  const parentPane = process.env.HERDR_PANE_ID;
  if (!parentPane || process.env.HERDR_ENV !== "1") {
    throw new Error(
      "herdr interactive mode requires pi to be running inside a herdr pane (HERDR_ENV=1 + HERDR_PANE_ID). Use background mode or run pi inside herdr.",
    );
  }
  return parentPane;
}

/** Create a tmux window/session and paste the framed task when pi is ready. */
export function spawnTmuxInteractivePane(opts: {
  tabLabel: string;
  cwd: string;
  framedTask: string;
  promptFile: string;
  onPasteFailed: () => void;
}): InteractiveBackend {
  const { tabLabel, cwd, framedTask, promptFile, onPasteFailed } = opts;
  const tmuxName = tabLabel;
  const piCmd = `env PI_TAB_LABEL=${tabLabel} pi`;

  let parentSession = "";
  try {
    parentSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"],
      { encoding: "utf8" }).trim();
  } catch {}

  let pasteTarget: string;
  if (parentSession) {
    pasteTarget = `${parentSession}:${tmuxName}`;
    execFileSync("tmux", [
      "new-window", "-t", parentSession, "-n", tmuxName, "-c", cwd, piCmd,
    ], { stdio: "ignore" });
  } else {
    pasteTarget = tmuxName;
    execFileSync("tmux", [
      "new-session", "-d", "-s", tmuxName, "-c", cwd, piCmd,
    ], { stdio: "ignore" });
    try {
      execFileSync("tmux", ["resize-window", "-t", tmuxName, "-x", "200", "-y", "50"],
        { stdio: "ignore" });
    } catch {}
  }

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
        onPasteFailed();
      }
    }
  }, 1000);

  return { kind: "tmux", target: pasteTarget, tabLabel };
}

/** Split a herdr pane, rename it, and start pi with the framed task. */
export function spawnHerdrInteractivePane(opts: {
  tabLabel: string;
  cwd: string;
  parentPane: string;
  framedTask: string;
}): InteractiveBackend {
  const { tabLabel, cwd, parentPane, framedTask } = opts;
  const agentName = tabLabel;

  let paneId: string;
  try {
    const raw = execFileSync("herdr", [
      "pane", "split",
      "--pane", parentPane,
      "--direction", "right",
      "--cwd", cwd,
      "--env", `PI_TAB_LABEL=${tabLabel}`,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    paneId = parsed?.result?.pane?.pane_id;
    if (!paneId) throw new Error("herdr pane split returned no pane_id");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`herdr pane split failed: ${msg}`);
  }

  // Immediate rename for UX before pi boots; PI_TAB_LABEL keeps auto-title from
  // overwriting with the framed prompt once pi starts.
  try { execFileSync("herdr", ["pane", "rename", paneId, tabLabel], { stdio: "ignore" }); }
  catch { /* cosmetic */ }

  try {
    execFileSync("herdr", [
      "agent", "start", agentName,
      "--kind", "pi",
      "--pane", paneId,
      "--", framedTask,
    ], { stdio: "ignore" });
  } catch (e: unknown) {
    try { execFileSync("herdr", ["pane", "close", paneId], { stdio: "ignore" }); } catch {}
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`herdr agent start failed: ${msg}`);
  }

  return { kind: "herdr", pane: paneId, agent: agentName, tabLabel };
}

export function formatTmuxResultMessage(
  id: string,
  elapsed: string,
  result: string,
  failed: boolean,
  errMsg?: string,
): string {
  if (failed) {
    return `## Subagent \`${id}\` failed (${elapsed})\n\n${errMsg || "No output."}`;
  }
  return `## Subagent \`${id}\` completed (${elapsed})\n\n${result}`;
}

export function formatHerdrResultMessage(
  id: string,
  tabLabel: string,
  agentName: string,
  elapsed: string,
  result: string,
  failed: boolean,
  errMsg?: string,
): string {
  if (failed) {
    return `## Subagent \`${id}\` failed (${elapsed})\n\n${errMsg || "No output. Pane may have been closed or pi failed to start."}`;
  }
  return `## Subagent \`${id}\` (${tabLabel}) completed (${elapsed})\n\n${result}\n\n_Steer it: \`herdr agent attach ${agentName}\` — pane left open._`;
}

export function readHerdrRecentOutput(paneId: string): string {
  try {
    return execFileSync("herdr",
      ["agent", "read", paneId, "--source", "recent", "--lines", "20"],
      { encoding: "utf8" }) || "";
  } catch {
    return "";
  }
}
