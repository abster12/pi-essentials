// src/control.ts
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
var CONTROL_FLAG = "session-control";
var CONTROL_TARGET_FLAG = "control-session";
var CONTROL_SEND_MESSAGE_FLAG = "send-session-message";
var CONTROL_SEND_MODE_FLAG = "send-session-mode";
var CONTROL_SEND_WAIT_FLAG = "send-session-wait";
var CONTROL_SEND_INCLUDE_SENDER_FLAG = "send-session-include-sender-info";
var CONTROL_DIR = path.join(os.homedir(), ".pi", "session-control");
var SOCKET_SUFFIX = ".sock";
var SESSION_MESSAGE_TYPE = "session-message";
var SENDER_INFO_PATTERN = /<sender_info>[\s\S]*?<\/sender_info>/g;
var CODEX_MODEL_ID = "gpt-5.1-codex-mini";
var HAIKU_MODEL_ID = "claude-haiku-4-5";
var SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer. Create concise, accurate summaries that preserve key information, decisions, and outcomes.`;
var TURN_SUMMARY_PROMPT = `Summarize what happened in this conversation since the last user prompt. Focus on:
- What was accomplished
- Any decisions made
- Files that were read, modified, or created
- Any errors or issues encountered
- Current state/next steps

Be concise but comprehensive. Preserve exact file paths, function names, and error messages.`;
async function selectSummarizationModel(currentModel, modelRegistry) {
  const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
  if (codexModel) {
    const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
    if (auth.ok) return codexModel;
  }
  const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
  if (haikuModel) {
    const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
    if (auth.ok) return haikuModel;
  }
  return currentModel;
}
var STATUS_KEY = "session-control";
function isErrnoException(error) {
  return typeof error === "object" && error !== null && "code" in error;
}
function getSocketPath(sessionId) {
  return path.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}
function isSafeSessionId(sessionId) {
  return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
}
function isSafeAlias(alias) {
  return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}
function getAliasPath(alias) {
  return path.join(CONTROL_DIR, `${alias}.alias`);
}
function getSessionAlias(ctx) {
  const sessionName = ctx.sessionManager.getSessionName();
  const alias = sessionName ? sessionName.trim() : "";
  if (!alias || !isSafeAlias(alias)) return null;
  return alias;
}
async function ensureControlDir() {
  await fs.mkdir(CONTROL_DIR, { recursive: true });
}
async function removeSocket(socketPath) {
  if (!socketPath) return;
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if (isErrnoException(error) && error.code !== "ENOENT") {
      throw error;
    }
  }
}
async function removeAliasesForSocket(socketPath) {
  if (!socketPath) return;
  try {
    const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const aliasPath = path.join(CONTROL_DIR, entry.name);
      let target;
      try {
        target = await fs.readlink(aliasPath);
      } catch {
        continue;
      }
      const resolvedTarget = path.resolve(CONTROL_DIR, target);
      if (resolvedTarget === socketPath) {
        await fs.unlink(aliasPath);
      }
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return;
    throw error;
  }
}
async function createAliasSymlink(sessionId, alias) {
  if (!alias || !isSafeAlias(alias)) return;
  const aliasPath = getAliasPath(alias);
  const target = `${sessionId}${SOCKET_SUFFIX}`;
  try {
    await fs.unlink(aliasPath);
  } catch (error) {
    if (isErrnoException(error) && error.code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fs.symlink(target, aliasPath);
  } catch (error) {
    if (isErrnoException(error) && error.code !== "EEXIST") {
      throw error;
    }
  }
}
async function resolveSessionIdFromAlias(alias) {
  if (!alias || !isSafeAlias(alias)) return null;
  const aliasPath = getAliasPath(alias);
  try {
    const target = await fs.readlink(aliasPath);
    const resolvedTarget = path.resolve(CONTROL_DIR, target);
    const base = path.basename(resolvedTarget);
    if (!base.endsWith(SOCKET_SUFFIX)) return null;
    const sessionId = base.slice(0, -SOCKET_SUFFIX.length);
    return isSafeSessionId(sessionId) ? sessionId : null;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    return null;
  }
}
async function getAliasMap() {
  const aliasMap = /* @__PURE__ */ new Map();
  const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".alias")) continue;
    const aliasPath = path.join(CONTROL_DIR, entry.name);
    let target;
    try {
      target = await fs.readlink(aliasPath);
    } catch {
      continue;
    }
    const resolvedTarget = path.resolve(CONTROL_DIR, target);
    const aliases = aliasMap.get(resolvedTarget);
    const aliasName = entry.name.slice(0, -".alias".length);
    if (aliases) {
      aliases.push(aliasName);
    } else {
      aliasMap.set(resolvedTarget, [aliasName]);
    }
  }
  return aliasMap;
}
async function isSocketAlive(socketPath) {
  return await new Promise((resolve2) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve2(false);
    }, 300);
    const cleanup = (alive) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      resolve2(alive);
    };
    socket.once("connect", () => {
      socket.end();
      cleanup(true);
    });
    socket.once("error", () => {
      cleanup(false);
    });
  });
}
async function getLiveSessions() {
  await ensureControlDir();
  const entries = await fs.readdir(CONTROL_DIR, { withFileTypes: true });
  const aliasMap = await getAliasMap();
  const sessions = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(SOCKET_SUFFIX)) continue;
    const socketPath = path.join(CONTROL_DIR, entry.name);
    const alive = await isSocketAlive(socketPath);
    if (!alive) continue;
    const sessionId = entry.name.slice(0, -SOCKET_SUFFIX.length);
    if (!isSafeSessionId(sessionId)) continue;
    const aliases = aliasMap.get(socketPath) ?? [];
    const name = aliases[0];
    sessions.push({ sessionId, name, aliases, socketPath });
  }
  sessions.sort((a, b) => (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId));
  return sessions;
}
async function syncAlias(state, ctx) {
  if (!state.server || !state.socketPath) return;
  const alias = getSessionAlias(ctx);
  if (alias && alias !== state.alias) {
    await removeAliasesForSocket(state.socketPath);
    await createAliasSymlink(ctx.sessionManager.getSessionId(), alias);
    state.alias = alias;
    return;
  }
  if (!alias && state.alias) {
    await removeAliasesForSocket(state.socketPath);
    state.alias = null;
  }
}
function writeResponse(socket, response) {
  try {
    socket.write(`${JSON.stringify(response)}
`);
  } catch {
  }
}
function writeEvent(socket, event) {
  try {
    socket.write(`${JSON.stringify(event)}
`);
  } catch {
  }
}
function parseCommand(line) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") {
      return { error: "Invalid command" };
    }
    if (typeof parsed.type !== "string") {
      return { error: "Missing command type" };
    }
    return { command: parsed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to parse command" };
  }
}
function getLastAssistantMessage(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message") {
      const msg = entry.message;
      if ("role" in msg && msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        const textParts = content.filter((c) => c.type === "text").map((c) => c.text);
        if (textParts.length > 0) {
          return {
            role: "assistant",
            content: textParts.join("\n"),
            timestamp: msg.timestamp
          };
        }
      }
    }
  }
  return void 0;
}
function getMessagesSinceLastPrompt(ctx) {
  const branch = ctx.sessionManager.getBranch();
  const messages = [];
  let lastUserIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && "role" in entry.message && entry.message.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) return [];
  for (let i = lastUserIndex; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type === "message") {
      const msg = entry.message;
      if ("role" in msg && (msg.role === "user" || msg.role === "assistant")) {
        const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        const textParts = content.filter((c) => c.type === "text").map((c) => c.text);
        if (textParts.length > 0) {
          messages.push({
            role: msg.role,
            content: textParts.join("\n"),
            timestamp: msg.timestamp
          });
        }
      }
    }
  }
  return messages;
}
function getFirstEntryId(ctx) {
  const entries = ctx.sessionManager.getEntries();
  if (entries.length === 0) return void 0;
  const root = entries.find((e) => e.parentId === null);
  return root?.id ?? entries[0]?.id;
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}
function stripSenderInfo(text) {
  return text.replace(SENDER_INFO_PATTERN, "").trim();
}
function parseSenderInfo(text) {
  const match = text.match(/<sender_info>([\s\S]*?)<\/sender_info>/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
      const sessionName = typeof parsed.sessionName === "string" ? parsed.sessionName.trim() : "";
      if (sessionId || sessionName) {
        return {
          sessionId: sessionId || void 0,
          sessionName: sessionName || void 0
        };
      }
    } catch {
    }
  }
  const legacyIdMatch = raw.match(/session\s+([a-f0-9-]{6,})/i);
  if (legacyIdMatch) {
    return { sessionId: legacyIdMatch[1] };
  }
  return null;
}
function formatSenderInfo(info) {
  if (!info) return null;
  const { sessionName, sessionId } = info;
  if (sessionName && sessionId) return `${sessionName} (${sessionId})`;
  if (sessionName) return sessionName;
  if (sessionId) return sessionId;
  return null;
}
function wrapSenderInfo(sessionId, sessionName) {
  if (!sessionId) return "";
  return `

<sender_info>${JSON.stringify({
    sessionId,
    sessionName: sessionName || void 0
  })}</sender_info>`;
}
var renderSessionMessage = (message, { expanded }, theme) => {
  const rawContent = extractTextContent(message.content);
  const senderInfo = parseSenderInfo(rawContent);
  let text = stripSenderInfo(rawContent);
  if (!text) text = "(no content)";
  if (!expanded) {
    const lines = text.split("\n");
    if (lines.length > 5) {
      text = `${lines.slice(0, 5).join("\n")}
...`;
    }
  }
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  const labelBase = theme.fg("customMessageLabel", `\x1B[1m[${message.customType}]\x1B[22m`);
  const senderText = formatSenderInfo(senderInfo);
  const label = senderText ? `${labelBase} ${theme.fg("dim", `from ${senderText}`)}` : labelBase;
  box.addChild(new Text(label, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(
    new Markdown(text, 0, 0, getMarkdownTheme(), {
      color: (value) => theme.fg("customMessageText", value)
    })
  );
  return box;
};
async function handleCommand(pi, state, command, socket) {
  const id = "id" in command && typeof command.id === "string" ? command.id : void 0;
  const respond = (success, commandName, data, error) => {
    if (state.context) {
      void syncAlias(state, state.context);
    }
    writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
  };
  const ctx = state.context;
  if (!ctx) {
    respond(false, command.type, void 0, "Session not ready");
    return;
  }
  void syncAlias(state, ctx);
  if (command.type === "abort") {
    ctx.abort();
    respond(true, "abort");
    return;
  }
  if (command.type === "subscribe") {
    if (command.event === "turn_end") {
      const subscriptionId = id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      state.turnEndSubscriptions.push({ socket, subscriptionId });
      const cleanup = () => {
        const idx = state.turnEndSubscriptions.findIndex((s) => s.subscriptionId === subscriptionId);
        if (idx !== -1) state.turnEndSubscriptions.splice(idx, 1);
      };
      socket.once("close", cleanup);
      socket.once("error", cleanup);
      respond(true, "subscribe", { subscriptionId, event: "turn_end" });
      return;
    }
    respond(false, "subscribe", void 0, `Unknown event type: ${command.event}`);
    return;
  }
  if (command.type === "get_message") {
    const message = getLastAssistantMessage(ctx);
    if (!message) {
      respond(true, "get_message", { message: null });
      return;
    }
    respond(true, "get_message", { message });
    return;
  }
  if (command.type === "get_summary") {
    const messages = getMessagesSinceLastPrompt(ctx);
    if (messages.length === 0) {
      respond(false, "get_summary", void 0, "No messages to summarize");
      return;
    }
    const model = await selectSummarizationModel(ctx.model, ctx.modelRegistry);
    if (!model) {
      respond(false, "get_summary", void 0, "No model available for summarization");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
      respond(false, "get_summary", void 0, auth.error);
      return;
    }
    try {
      const conversationText = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
      const userMessage = {
        role: "user",
        content: [{ type: "text", text: `<conversation>
${conversationText}
</conversation>

${TURN_SUMMARY_PROMPT}` }],
        timestamp: Date.now()
      };
      const response = await complete(
        model,
        { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers }
      );
      if (response.stopReason === "aborted" || response.stopReason === "error") {
        respond(false, "get_summary", void 0, "Summarization failed");
        return;
      }
      const summary = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      respond(true, "get_summary", { summary, model: model.id });
    } catch (error) {
      respond(false, "get_summary", void 0, error instanceof Error ? error.message : "Summarization failed");
    }
    return;
  }
  if (command.type === "clear") {
    if (!ctx.isIdle()) {
      respond(false, "clear", void 0, "Session is busy - wait for turn to complete");
      return;
    }
    const firstEntryId = getFirstEntryId(ctx);
    if (!firstEntryId) {
      respond(false, "clear", void 0, "No entries in session");
      return;
    }
    const currentLeafId = ctx.sessionManager.getLeafId();
    if (currentLeafId === firstEntryId) {
      respond(true, "clear", { cleared: true, alreadyAtRoot: true });
      return;
    }
    if (command.summarize) {
      respond(false, "clear", void 0, "Clear with summarization not supported via RPC - use summarize=false");
      return;
    }
    try {
      const sessionManager = ctx.sessionManager;
      sessionManager.branch(firstEntryId);
      respond(true, "clear", { cleared: true, targetId: firstEntryId });
    } catch (error) {
      respond(false, "clear", void 0, error instanceof Error ? error.message : "Clear failed");
    }
    return;
  }
  if (command.type === "send") {
    const message = command.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      respond(false, "send", void 0, "Missing message");
      return;
    }
    const mode = command.mode ?? "steer";
    const isIdle = ctx.isIdle();
    const customMessage = {
      customType: SESSION_MESSAGE_TYPE,
      content: message,
      display: true
    };
    if (isIdle) {
      pi.sendMessage(customMessage, { triggerTurn: true });
    } else {
      pi.sendMessage(customMessage, {
        triggerTurn: true,
        deliverAs: mode === "follow_up" ? "followUp" : "steer"
      });
    }
    respond(true, "send", { delivered: true, mode: isIdle ? "direct" : mode });
    return;
  }
  const unsupportedType = command.type;
  respond(false, unsupportedType, void 0, `Unsupported command: ${unsupportedType}`);
}
async function createServer2(pi, state, socketPath) {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        const parsed = parseCommand(line);
        if (parsed.error) {
          if (state.context) {
            void syncAlias(state, state.context);
          }
          writeResponse(socket, {
            type: "response",
            command: "parse",
            success: false,
            error: `Failed to parse command: ${parsed.error}`
          });
          continue;
        }
        void handleCommand(pi, state, parsed.command, socket).catch((error) => {
          writeResponse(socket, {
            type: "response",
            command: parsed.command.type,
            success: false,
            error: error instanceof Error ? error.message : "Command failed"
          });
        });
      }
    });
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve2();
    });
  });
  return server;
}
async function sendRpcCommand(socketPath, command, options = {}) {
  const { timeout = 5e3, waitForEvent } = options;
  return new Promise((resolve2, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const timeoutHandle = setTimeout(() => {
      socket.destroy(new Error("timeout"));
    }, timeout);
    let buffer = "";
    let response = null;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      socket.removeAllListeners();
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(command)}
`);
      if (waitForEvent === "turn_end") {
        const subscribeCmd = { type: "subscribe", event: "turn_end" };
        socket.write(`${JSON.stringify(subscribeCmd)}
`);
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "response") {
            if (msg.command === command.type) {
              const rpcResponse = msg;
              response = rpcResponse;
              if (!waitForEvent) {
                cleanup();
                socket.end();
                resolve2({ response: rpcResponse });
                return;
              }
            }
            continue;
          }
          if (msg.type === "event" && msg.event === "turn_end" && waitForEvent === "turn_end") {
            cleanup();
            socket.end();
            if (!response) {
              reject(new Error("Received event before response"));
              return;
            }
            resolve2({ response, event: msg.data || {} });
            return;
          }
        } catch {
        }
      }
    });
    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function startControlServer(pi, state, ctx) {
  await ensureControlDir();
  const sessionId = ctx.sessionManager.getSessionId();
  const socketPath = getSocketPath(sessionId);
  if (state.socketPath === socketPath && state.server) {
    state.context = ctx;
    await syncAlias(state, ctx);
    return;
  }
  await stopControlServer(state);
  await removeSocket(socketPath);
  state.context = ctx;
  state.socketPath = socketPath;
  state.server = await createServer2(pi, state, socketPath);
  state.alias = null;
  await syncAlias(state, ctx);
}
async function stopControlServer(state) {
  if (!state.server) {
    await removeAliasesForSocket(state.socketPath);
    await removeSocket(state.socketPath);
    state.socketPath = null;
    state.alias = null;
    return;
  }
  const socketPath = state.socketPath;
  state.socketPath = null;
  state.turnEndSubscriptions = [];
  await new Promise((resolve2) => state.server?.close(() => resolve2()));
  state.server = null;
  await removeAliasesForSocket(socketPath);
  await removeSocket(socketPath);
  state.alias = null;
}
function updateStatus(ctx, enabled) {
  if (!ctx?.hasUI) return;
  if (!enabled) {
    ctx.ui.setStatus(STATUS_KEY, void 0);
    return;
  }
  const sessionId = ctx.sessionManager.getSessionId();
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `session ${sessionId}`));
}
function updateSessionEnv(ctx, enabled) {
  if (!enabled) {
    delete process.env.PI_SESSION_ID;
    return;
  }
  if (!ctx) return;
  process.env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
}
function wasBooleanFlagPassed(flagName) {
  const flag = `--${flagName}`;
  return process.argv.slice(2).includes(flag);
}
function shouldRegisterControlTools(pi) {
  return pi.getFlag(CONTROL_FLAG) === true || wasBooleanFlagPassed(CONTROL_FLAG);
}
function control_default(pi) {
  pi.registerFlag(CONTROL_FLAG, {
    description: "Enable per-session control socket under ~/.pi/session-control",
    type: "boolean"
  });
  pi.registerFlag(CONTROL_TARGET_FLAG, {
    description: "Target session name or session id for startup control send",
    type: "string"
  });
  pi.registerFlag(CONTROL_SEND_MESSAGE_FLAG, {
    description: "Message to send to --control-session at startup",
    type: "string"
  });
  pi.registerFlag(CONTROL_SEND_MODE_FLAG, {
    description: "Startup send mode: steer or follow_up",
    type: "string",
    default: "steer"
  });
  pi.registerFlag(CONTROL_SEND_WAIT_FLAG, {
    description: "Startup send wait mode: turn_end or message_processed",
    type: "string"
  });
  pi.registerFlag(CONTROL_SEND_INCLUDE_SENDER_FLAG, {
    description: "Include <sender_info> in startup messages (advanced; default: false)",
    type: "boolean"
  });
  let cliSendHandled = false;
  const state = {
    server: null,
    socketPath: null,
    context: null,
    alias: null,
    aliasTimer: null,
    turnEndSubscriptions: []
  };
  pi.registerMessageRenderer(SESSION_MESSAGE_TYPE, renderSessionMessage);
  if (shouldRegisterControlTools(pi)) {
    registerSessionTool(pi, state);
    registerListSessionsTool(pi);
  }
  registerControlSessionsCommand(pi);
  const refreshServer = async (ctx) => {
    const enabled = pi.getFlag(CONTROL_FLAG) === true;
    if (!enabled) {
      if (state.aliasTimer) {
        clearInterval(state.aliasTimer);
        state.aliasTimer = null;
      }
      await stopControlServer(state);
      updateStatus(ctx, false);
      updateSessionEnv(ctx, false);
      return;
    }
    await startControlServer(pi, state, ctx);
    if (!state.aliasTimer) {
      state.aliasTimer = setInterval(() => {
        if (!state.context) return;
        void syncAlias(state, state.context);
      }, 1e3);
    }
    updateStatus(ctx, true);
    updateSessionEnv(ctx, true);
  };
  pi.on("session_start", async (_event, ctx) => {
    await refreshServer(ctx);
    if (!cliSendHandled) {
      cliSendHandled = true;
      await maybeHandleStartupControlSend(pi, ctx);
    }
  });
  pi.on("session_info_changed", (_event, ctx) => {
    state.context = ctx;
    void syncAlias(state, ctx);
  });
  pi.on("session_shutdown", async () => {
    if (state.aliasTimer) {
      clearInterval(state.aliasTimer);
      state.aliasTimer = null;
    }
    updateStatus(state.context, false);
    updateSessionEnv(state.context, false);
    await stopControlServer(state);
  });
  pi.on("turn_end", (event, ctx) => {
    if (state.turnEndSubscriptions.length === 0) return;
    void syncAlias(state, ctx);
    const lastMessage = getLastAssistantMessage(ctx);
    const eventData = { message: lastMessage, turnIndex: event.turnIndex };
    const subscriptions = [...state.turnEndSubscriptions];
    state.turnEndSubscriptions = [];
    for (const sub of subscriptions) {
      writeEvent(sub.socket, {
        type: "event",
        event: "turn_end",
        data: eventData,
        subscriptionId: sub.subscriptionId
      });
    }
  });
}
function registerSessionTool(pi, state) {
  pi.registerTool({
    name: "send_to_session",
    label: "Send To Session",
    description: `Interact with another running pi session via its control socket.

Actions:
- send: Send a message (default). Requires 'message' parameter.
- get_message: Get the most recent assistant message.
- get_summary: Get a summary of activity since the last user prompt.
- clear: Rewind session to initial state.

Target selection:
- sessionId: UUID of the session.
- sessionName: session name (alias from /name).

Wait behavior (only for action=send):
- wait_until=turn_end: Wait for the turn to complete, returns last assistant message.
- wait_until=message_processed: Returns immediately after message is queued.

CLI bridge (for shell scripts/background jobs):
- Current session id is available in shell/bash as $PI_SESSION_ID (set when --session-control is enabled).
- Use $PI_SESSION_ID when you need the current session; do not call list_sessions just to discover your own id.
- Target session must be running with --session-control.
- One-shot startup send is available via extension flags:
  --session-control
  --control-session <session-name|session-id>
  --send-session-message <text>
  --send-session-mode <steer|follow_up> (optional, default: steer)
  --send-session-wait <turn_end|message_processed> (optional)
  --send-session-include-sender-info (optional, advanced; default: off)
- Startup sends are one-way by default (no sender_info), which avoids reply attempts to short-lived 'pi -p' sender sessions.
- If a script needs a response, use --send-session-wait turn_end and read stdout.
- Example script usage (one-way):
  pi -p --session-control --control-session "$PI_SESSION_ID" --send-session-message "Background task finished" --send-session-mode follow_up --send-session-wait message_processed
- Example request/response usage:
  pi -p --session-control --control-session "$PI_SESSION_ID" --send-session-message "What is the current time?" --send-session-wait turn_end

Note: If you ask the target session to reply back via sender_info, do not use wait_until; waiting is redundant and can duplicate responses.

Messages automatically include sender session info for replies. When you want a response, instruct the target session to reply directly to the sender by calling send_to_session with the sender_info reference (do not poll get_message).`,
    promptGuidelines: [
      "Use send_to_session to talk to another running pi session started with --session-control. Prefer sessionName when the user named the session. Use list_sessions for discovery; the current session id is $PI_SESSION_ID."
    ],
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ description: "Target session id (UUID)" })),
      sessionName: Type.Optional(Type.String({ description: "Target session name (alias)" })),
      action: Type.Optional(
        Type.Union(
          [Type.Literal("send"), Type.Literal("get_message"), Type.Literal("get_summary"), Type.Literal("clear")],
          { description: "Action to perform (default: send)", default: "send" }
        )
      ),
      message: Type.Optional(Type.String({ description: "Message to send (required for action=send)" })),
      mode: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("follow_up")], {
          description: "Delivery mode for send: steer (immediate) or follow_up (after task)",
          default: "steer"
        })
      ),
      wait_until: Type.Optional(
        Type.Union([Type.Literal("turn_end"), Type.Literal("message_processed")], {
          description: "Wait behavior for send action"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action ?? "send";
      const sessionName = params.sessionName?.trim();
      const sessionId = params.sessionId?.trim();
      let targetSessionId = null;
      const displayTarget = sessionName || sessionId || "";
      if (sessionName) {
        targetSessionId = await resolveSessionIdFromAlias(sessionName);
        if (!targetSessionId) {
          return {
            content: [{ type: "text", text: "Unknown session name" }],
            isError: true,
            details: { error: "Unknown session name" }
          };
        }
      }
      if (sessionId) {
        if (!isSafeSessionId(sessionId)) {
          return {
            content: [{ type: "text", text: "Invalid session id" }],
            isError: true,
            details: { error: "Invalid session id" }
          };
        }
        if (targetSessionId && targetSessionId !== sessionId) {
          return {
            content: [{ type: "text", text: "Session name does not match session id" }],
            isError: true,
            details: { error: "Session name does not match session id" }
          };
        }
        targetSessionId = sessionId;
      }
      if (!targetSessionId) {
        return {
          content: [{ type: "text", text: "Missing session id or session name" }],
          isError: true,
          details: { error: "Missing session id or session name" }
        };
      }
      const socketPath = getSocketPath(targetSessionId);
      const senderSessionId = state.context?.sessionManager.getSessionId();
      try {
        if (action === "get_message") {
          const result2 = await sendRpcCommand(socketPath, { type: "get_message" });
          if (!result2.response.success) {
            return {
              content: [{ type: "text", text: `Failed: ${result2.response.error ?? "unknown error"}` }],
              isError: true,
              details: result2
            };
          }
          const data = result2.response.data;
          if (!data?.message) {
            return {
              content: [{ type: "text", text: "No assistant message found in session" }],
              details: result2
            };
          }
          return {
            content: [{ type: "text", text: data.message.content }],
            details: { message: data.message }
          };
        }
        if (action === "get_summary") {
          const result2 = await sendRpcCommand(socketPath, { type: "get_summary" }, { timeout: 6e4 });
          if (!result2.response.success) {
            return {
              content: [{ type: "text", text: `Failed: ${result2.response.error ?? "unknown error"}` }],
              isError: true,
              details: result2
            };
          }
          const data = result2.response.data;
          if (!data?.summary) {
            return {
              content: [{ type: "text", text: "No summary generated" }],
              details: result2
            };
          }
          return {
            content: [{ type: "text", text: `Summary (via ${data.model}):

${data.summary}` }],
            details: { summary: data.summary, model: data.model }
          };
        }
        if (action === "clear") {
          const result2 = await sendRpcCommand(socketPath, { type: "clear", summarize: false }, { timeout: 1e4 });
          if (!result2.response.success) {
            return {
              content: [{ type: "text", text: `Failed to clear: ${result2.response.error ?? "unknown error"}` }],
              isError: true,
              details: result2
            };
          }
          const data = result2.response.data;
          const msg = data?.alreadyAtRoot ? "Session already at root" : "Session cleared";
          return {
            content: [{ type: "text", text: msg }],
            details: data
          };
        }
        if (!params.message || params.message.trim().length === 0) {
          return {
            content: [{ type: "text", text: "Missing message for send action" }],
            isError: true,
            details: { error: "Missing message" }
          };
        }
        const senderSessionName = state.context?.sessionManager.getSessionName()?.trim();
        const senderInfo = wrapSenderInfo(senderSessionId, senderSessionName);
        const sendCommand = {
          type: "send",
          message: params.message + senderInfo,
          mode: params.mode ?? "steer"
        };
        if (params.wait_until === "message_processed") {
          const result2 = await sendRpcCommand(socketPath, sendCommand);
          if (!result2.response.success) {
            return {
              content: [{ type: "text", text: `Failed: ${result2.response.error ?? "unknown error"}` }],
              isError: true,
              details: result2
            };
          }
          return {
            content: [{ type: "text", text: "Message delivered to session" }],
            details: result2.response.data
          };
        }
        if (params.wait_until === "turn_end") {
          const result2 = await sendRpcCommand(socketPath, sendCommand, {
            timeout: 3e5,
            // 5 minutes
            waitForEvent: "turn_end"
          });
          if (!result2.response.success) {
            return {
              content: [{ type: "text", text: `Failed: ${result2.response.error ?? "unknown error"}` }],
              isError: true,
              details: result2
            };
          }
          const lastMessage = result2.event?.message;
          if (!lastMessage) {
            return {
              content: [{ type: "text", text: "Turn completed but no assistant message found" }],
              details: { turnIndex: result2.event?.turnIndex }
            };
          }
          return {
            content: [{ type: "text", text: lastMessage.content }],
            details: { message: lastMessage, turnIndex: result2.event?.turnIndex }
          };
        }
        const result = await sendRpcCommand(socketPath, sendCommand);
        if (!result.response.success) {
          return {
            content: [{ type: "text", text: `Failed: ${result.response.error ?? "unknown error"}` }],
            isError: true,
            details: result
          };
        }
        return {
          content: [{ type: "text", text: `Message sent to session ${displayTarget || targetSessionId}` }],
          details: result.response.data
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
          isError: true,
          details: { error: message }
        };
      }
    },
    renderCall(args, theme) {
      const action = args.action ?? "send";
      const sessionRef = args.sessionName ?? args.sessionId ?? "...";
      const shortSessionRef = sessionRef.length > 12 ? sessionRef.slice(0, 8) + "..." : sessionRef;
      let header = theme.fg("toolTitle", theme.bold("\u2192 session "));
      header += theme.fg("accent", shortSessionRef);
      if (action === "send") {
        const mode = args.mode ?? "steer";
        const wait = args.wait_until;
        let info = theme.fg("muted", ` (${mode}`);
        if (wait) info += theme.fg("dim", `, wait: ${wait}`);
        info += theme.fg("muted", ")");
        header += info;
      } else {
        header += theme.fg("muted", ` (${action})`);
      }
      if (action === "send" && args.message) {
        const msg = args.message;
        const preview = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
        const firstLine = preview.split("\n")[0];
        const hasMore = preview.includes("\n") || msg.length > 80;
        return new Text(
          header + "\n  " + theme.fg("dim", `"${firstLine}${hasMore ? "..." : ""}"`),
          0,
          0
        );
      }
      return new Text(header, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      const isError = result.isError === true;
      if (isError || details?.error) {
        const errorMsg = typeof details?.error === "string" && details.error || (result.content[0]?.type === "text" ? result.content[0].text : "Unknown error");
        return new Text(theme.fg("error", "\u2717 ") + theme.fg("error", errorMsg), 0, 0);
      }
      const hasMessage = details && "message" in details && details.message;
      const hasSummary = details && "summary" in details;
      const hasCleared = details && "cleared" in details;
      const hasTurnIndex = details && "turnIndex" in details;
      if (hasMessage) {
        const message = details.message;
        const icon = theme.fg("success", "\u2713");
        if (expanded) {
          const container = new Container();
          container.addChild(new Text(icon + theme.fg("muted", " Message received"), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(message.content, 0, 0, getMarkdownTheme()));
          if (hasTurnIndex) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Turn #${details.turnIndex}`), 0, 0));
          }
          return container;
        }
        const preview = message.content.length > 200 ? message.content.slice(0, 200) + "..." : message.content;
        const lines = preview.split("\n").slice(0, 5);
        let text2 = icon + theme.fg("muted", " Message received");
        if (hasTurnIndex) text2 += theme.fg("dim", ` (turn #${details.turnIndex})`);
        text2 += "\n" + theme.fg("toolOutput", lines.join("\n"));
        if (message.content.split("\n").length > 5 || message.content.length > 200) {
          text2 += "\n" + theme.fg("dim", "(Ctrl+O to expand)");
        }
        return new Text(text2, 0, 0);
      }
      if (hasSummary) {
        const summary = details.summary;
        const model = details.model;
        const icon = theme.fg("success", "\u2713");
        if (expanded) {
          const container = new Container();
          let header = icon + theme.fg("muted", " Summary");
          if (model) header += theme.fg("dim", ` via ${model}`);
          container.addChild(new Text(header, 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(summary, 0, 0, getMarkdownTheme()));
          return container;
        }
        const preview = summary.length > 200 ? summary.slice(0, 200) + "..." : summary;
        const lines = preview.split("\n").slice(0, 5);
        let text2 = icon + theme.fg("muted", " Summary");
        if (model) text2 += theme.fg("dim", ` via ${model}`);
        text2 += "\n" + theme.fg("toolOutput", lines.join("\n"));
        if (summary.split("\n").length > 5 || summary.length > 200) {
          text2 += "\n" + theme.fg("dim", "(Ctrl+O to expand)");
        }
        return new Text(text2, 0, 0);
      }
      if (hasCleared) {
        const alreadyAtRoot = details.alreadyAtRoot;
        const icon = theme.fg("success", "\u2713");
        const msg = alreadyAtRoot ? "Session already at root" : "Session cleared";
        return new Text(icon + " " + theme.fg("muted", msg), 0, 0);
      }
      if (details && "delivered" in details) {
        const mode = details.mode;
        const icon = theme.fg("success", "\u2713");
        let text2 = icon + theme.fg("muted", " Message delivered");
        if (mode) text2 += theme.fg("dim", ` (${mode})`);
        return new Text(text2, 0, 0);
      }
      const text = result.content[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("success", "\u2713 ") + theme.fg("muted", content), 0, 0);
    }
  });
}
function registerListSessionsTool(pi) {
  pi.registerTool({
    name: "list_sessions",
    label: "List Sessions",
    description: "List live sessions that expose a control socket (optionally with session names). Use this for discovery only; for the current session id in shell/bash use $PI_SESSION_ID.",
    promptGuidelines: [
      "Use list_sessions to discover other live pi sessions. For the current session id in shell, use $PI_SESSION_ID."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const sessions = await getLiveSessions();
      if (sessions.length === 0) {
        return {
          content: [{ type: "text", text: "No live sessions found." }],
          details: { sessions: [] }
        };
      }
      const lines = sessions.map((session) => {
        const name = session.name ? ` (${session.name})` : "";
        return `- ${session.sessionId}${name}`;
      });
      return {
        content: [{ type: "text", text: `Live sessions:
${lines.join("\n")}` }],
        details: { sessions }
      };
    }
  });
}
function normalizeMode(raw) {
  const value = raw.trim().toLowerCase();
  if (value === "steer") return "steer";
  if (value === "follow_up" || value === "follow-up" || value === "followup") return "follow_up";
  return null;
}
function normalizeWaitUntil(raw) {
  const value = raw.trim().toLowerCase();
  if (value === "turn_end" || value === "turn-end") return "turn_end";
  if (value === "message_processed" || value === "message-processed") return "message_processed";
  return null;
}
function getStringFlag(pi, name) {
  const value = pi.getFlag(name);
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function parseStartupControlSendOptions(pi) {
  const target = getStringFlag(pi, CONTROL_TARGET_FLAG);
  const message = getStringFlag(pi, CONTROL_SEND_MESSAGE_FLAG);
  if (!target && !message) {
    return {};
  }
  if (target && !message) {
    return { error: `Missing --${CONTROL_SEND_MESSAGE_FLAG} (required with --${CONTROL_TARGET_FLAG})` };
  }
  if (!target && message) {
    return { error: `Missing --${CONTROL_TARGET_FLAG} (required with --${CONTROL_SEND_MESSAGE_FLAG})` };
  }
  const rawMode = getStringFlag(pi, CONTROL_SEND_MODE_FLAG) ?? "steer";
  const mode = normalizeMode(rawMode);
  if (!mode) {
    return { error: `Invalid --${CONTROL_SEND_MODE_FLAG}: ${rawMode}. Use steer|follow_up.` };
  }
  const rawWait = getStringFlag(pi, CONTROL_SEND_WAIT_FLAG);
  let waitUntil;
  if (rawWait) {
    const normalized = normalizeWaitUntil(rawWait);
    if (!normalized) {
      return {
        error: `Invalid --${CONTROL_SEND_WAIT_FLAG}: ${rawWait}. Use turn_end|message_processed.`
      };
    }
    waitUntil = normalized;
  }
  const includeSenderInfo = pi.getFlag(CONTROL_SEND_INCLUDE_SENDER_FLAG) === true;
  return {
    options: {
      target,
      message,
      mode,
      waitUntil,
      includeSenderInfo
    }
  };
}
function reportStartupControlSend(ctx, message, level = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (level === "error") {
    console.error(message);
    return;
  }
  console.log(message);
}
async function maybeHandleStartupControlSend(pi, ctx) {
  const parsed = parseStartupControlSendOptions(pi);
  if (!parsed.options) {
    if (parsed.error) {
      reportStartupControlSend(ctx, parsed.error, "error");
    }
    return;
  }
  const { target, message, mode, waitUntil, includeSenderInfo } = parsed.options;
  let targetSessionId = await resolveSessionIdFromAlias(target);
  if (!targetSessionId && isSafeSessionId(target)) {
    targetSessionId = target;
  }
  if (!targetSessionId) {
    reportStartupControlSend(ctx, `Unknown target session: ${target}`, "error");
    return;
  }
  const socketPath = getSocketPath(targetSessionId);
  const alive = await isSocketAlive(socketPath);
  if (!alive) {
    reportStartupControlSend(ctx, `Target session not reachable: ${target}`, "error");
    return;
  }
  const senderInfo = includeSenderInfo ? wrapSenderInfo(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionName()?.trim()) : "";
  const sendCommand = {
    type: "send",
    message: message + senderInfo,
    mode
  };
  try {
    if (waitUntil === "turn_end") {
      const result2 = await sendRpcCommand(socketPath, sendCommand, {
        timeout: 3e5,
        waitForEvent: "turn_end"
      });
      if (!result2.response.success) {
        reportStartupControlSend(ctx, `Failed to send: ${result2.response.error ?? "unknown error"}`, "error");
        return;
      }
      const lastMessage = result2.event?.message;
      if (!lastMessage?.content) {
        reportStartupControlSend(ctx, `Message delivered to ${target}; turn completed without assistant output.`);
        return;
      }
      if (ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "control-send",
            content: `Startup response from ${target}:

${lastMessage.content}`,
            display: true
          },
          { triggerTurn: false }
        );
      } else {
        console.log(lastMessage.content);
      }
      return;
    }
    const result = await sendRpcCommand(socketPath, sendCommand, { timeout: 3e4 });
    if (!result.response.success) {
      reportStartupControlSend(ctx, `Failed to send: ${result.response.error ?? "unknown error"}`, "error");
      return;
    }
    const waitLabel = waitUntil === "message_processed" ? " (message processed)" : "";
    reportStartupControlSend(ctx, `Message sent to ${target}${waitLabel}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    reportStartupControlSend(ctx, `Failed to send to ${target}: ${msg}`, "error");
  }
}
function registerControlSessionsCommand(pi) {
  pi.registerCommand("control-sessions", {
    description: "List controllable sessions (from session-control sockets)",
    handler: async (_args, ctx) => {
      if (pi.getFlag(CONTROL_FLAG) !== true) {
        if (ctx.hasUI) {
          ctx.ui.notify("Session control not enabled (use --session-control)", "warning");
        }
        return;
      }
      const sessions = await getLiveSessions();
      const currentSessionId = ctx.sessionManager.getSessionId();
      const lines = sessions.map((session) => {
        const name = session.name ? ` (${session.name})` : "";
        const current = session.sessionId === currentSessionId ? " (current)" : "";
        return `- ${session.sessionId}${name}${current}`;
      });
      const content = sessions.length === 0 ? "No live sessions found." : `Controllable sessions:
${lines.join("\n")}`;
      pi.sendMessage(
        {
          customType: "control-sessions",
          content,
          display: true
        },
        { triggerTurn: false }
      );
    }
  });
}
export {
  control_default as default,
  formatSenderInfo,
  isSafeAlias,
  isSafeSessionId,
  normalizeMode,
  normalizeWaitUntil,
  parseCommand,
  parseSenderInfo,
  stripSenderInfo,
  wrapSenderInfo
};
//# sourceMappingURL=control.js.map
