// src/no-sleep.ts
import { spawn } from "node:child_process";
var MACOS = process.platform === "darwin";
var caffeinate;
var enabled = readBooleanEnv("PI_NO_SLEEP", true);
var scope = readScopeEnv();
var agentActive = false;
var lastError;
function readBooleanEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === void 0 || value === "") {
    return defaultValue;
  }
  return !/^(0|false|no|off)$/i.test(value);
}
function readScopeEnv() {
  return /^session$/i.test(process.env.PI_NO_SLEEP_SCOPE ?? "") ? "session" : "agent";
}
function caffeinateArgs() {
  const args = ["-i", "-s"];
  if (readBooleanEnv("PI_NO_SLEEP_DISPLAY", false)) {
    args.push("-d");
  }
  args.push("-w", String(process.pid));
  return args;
}
function notify(ctx, message, level = "info") {
  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
  }
}
function start(ctx) {
  if (!enabled || !MACOS || caffeinate) {
    return;
  }
  lastError = void 0;
  const child = spawn("caffeinate", caffeinateArgs(), { stdio: "ignore" });
  child.unref();
  caffeinate = child;
  child.once("error", (error) => {
    if (caffeinate !== child) {
      return;
    }
    caffeinate = void 0;
    lastError = error.message;
    notify(ctx, `No Sleep: failed to caffeinate: ${error.message}`, "error");
  });
  child.once("exit", (code, signal) => {
    if (caffeinate !== child) {
      return;
    }
    caffeinate = void 0;
    if (code && code !== 0) {
      lastError = `caffeinate exited with code ${code}`;
      notify(ctx, `No Sleep: caffeinate stopped unexpectedly (${lastError}).`, "warning");
    } else if (signal) {
      lastError = `caffeinate exited after signal ${signal}`;
      notify(ctx, `No Sleep: caffeinate stopped unexpectedly (${lastError}).`, "warning");
    }
  });
}
function stop(ctx) {
  const child = caffeinate;
  caffeinate = void 0;
  if (!child) {
    return;
  }
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 1e3);
    timer.unref?.();
  }
}
function reconcile(ctx) {
  if (!enabled) {
    stop(ctx);
    return;
  }
  if (scope === "session" || agentActive) {
    start(ctx);
  } else {
    stop(ctx);
  }
}
function describeState() {
  if (!MACOS) {
    return "No Sleep is inactive: caffeinate is only available on macOS.";
  }
  const state = caffeinate ? `active (pid ${caffeinate.pid ?? "unknown"})` : "idle";
  const display = readBooleanEnv("PI_NO_SLEEP_DISPLAY", false) ? "yes" : "no";
  return [
    `No Sleep is ${enabled ? "enabled" : "disabled"}.`,
    `scope: ${scope}`,
    `state: ${state}`,
    `keeps display awake: ${display}`,
    lastError ? `last error: ${lastError}` : void 0
  ].filter(Boolean).join("\n");
}
function noSleepExtension(pi) {
  const cleanupOnProcessExit = () => {
    stop(void 0);
  };
  process.once("exit", cleanupOnProcessExit);
  pi.on("session_start", (_event, ctx) => {
    agentActive = false;
    reconcile(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    agentActive = true;
    reconcile(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    agentActive = false;
    reconcile(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    agentActive = false;
    stop(ctx);
    process.off("exit", cleanupOnProcessExit);
  });
  pi.registerCommand("no-sleep", {
    description: "Show or change macOS sleep-prevention status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "on" || command === "enable") {
        enabled = true;
        reconcile(ctx);
      } else if (command === "off" || command === "disable") {
        enabled = false;
        reconcile(ctx);
      } else if (command === "toggle") {
        enabled = !enabled;
        reconcile(ctx);
      } else if (command === "agent") {
        scope = "agent";
        reconcile(ctx);
      } else if (command === "session") {
        scope = "session";
        reconcile(ctx);
      } else if (command && command !== "status") {
        notify(ctx, "Usage: /no-sleep [status|on|off|toggle|agent|session]", "warning");
        return;
      }
      notify(ctx, describeState(), lastError ? "warning" : "info");
    }
  });
}
export {
  noSleepExtension as default
};
//# sourceMappingURL=no-sleep.js.map
