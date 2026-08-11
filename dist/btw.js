// src/btw.ts
import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  getMarkdownTheme,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Markdown,
  truncateToWidth,
  visibleWidth
} from "@earendil-works/pi-tui";
var BTW_ENTRY_TYPE = "btw-thread-entry";
var BTW_RESET_TYPE = "btw-thread-reset";
var BTW_SYSTEM_PROMPT = [
  "You are BTW, a side-channel assistant embedded in the user's coding agent.",
  "You have access to the main conversation context \u2014 use it to give informed answers.",
  "Help with focused questions, planning, and quick explorations.",
  "Be direct and practical."
].join(" ");
var BTW_SUMMARY_PROMPT = "Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";
function stripDynamicSystemPromptFooter(systemPrompt) {
  return systemPrompt.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "").replace(/\nCurrent working directory:[^\n]*$/u, "").trim();
}
function createBtwResourceLoader(ctx, appendSystemPrompt = [BTW_SYSTEM_PROMPT]) {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => void 0,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
    },
    reload: async () => {
    }
  };
}
function extractText(parts) {
  return parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}
function extractEventAssistantText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const maybeMessage = message;
  if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) {
    return "";
  }
  return maybeMessage.content.filter((part) => {
    return !!part && typeof part === "object" && part.type === "text";
  }).map((part) => part.text).join("\n").trim();
}
function getLastAssistantMessage(session) {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}
function buildSeedMessages(ctx, thread) {
  const seed = [];
  try {
    const contextMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
    seed.push(...contextMessages.filter((message) => "role" in message));
  } catch {
  }
  for (const item of thread) {
    seed.push(
      {
        role: "user",
        content: [{ type: "text", text: item.question }],
        timestamp: item.timestamp
      },
      {
        role: "assistant",
        content: [{ type: "text", text: item.answer }],
        provider: item.provider,
        model: item.model,
        api: ctx.model?.api ?? "openai-responses",
        usage: item.usage ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: item.timestamp
      }
    );
  }
  return seed;
}
function formatThread(thread) {
  return thread.map((item) => `User: ${item.question.trim()}
Assistant: ${item.answer.trim()}`).join("\n\n---\n\n");
}
function notify(ctx, message, level) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}
var BtwOverlay = class extends Container {
  input;
  tui;
  theme;
  keybindings;
  getTranscript;
  getStatus;
  onSubmitCallback;
  onDismissCallback;
  _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.input.focused = value;
  }
  constructor(tui, theme, keybindings, getTranscript, getStatus, onSubmit, onDismiss) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.getTranscript = getTranscript;
    this.getStatus = getStatus;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };
  }
  handleInput(data) {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onDismissCallback();
      return;
    }
    this.input.handleInput(data);
  }
  setDraft(value) {
    this.input.setValue(value);
    this.tui.requestRender();
  }
  getDraft() {
    return this.input.getValue();
  }
  frameLine(content, innerWidth) {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "\u2502")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "\u2502")}`;
  }
  borderLine(innerWidth, edge) {
    const left = edge === "top" ? "\u250C" : "\u2514";
    const right = edge === "top" ? "\u2510" : "\u2518";
    return this.theme.fg("borderMuted", `${left}${"\u2500".repeat(innerWidth)}${right}`);
  }
  render(width) {
    const dialogWidth = Math.max(56, Math.min(width, Math.floor(width * 0.9)));
    const innerWidth = Math.max(40, dialogWidth - 2);
    const terminalRows = process.stdout.rows ?? 30;
    const dialogHeight = Math.max(16, Math.min(30, Math.floor(terminalRows * 0.75)));
    const chromeHeight = 7;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    const transcript = this.getTranscript(innerWidth, this.theme);
    const visibleTranscript = transcript.slice(-transcriptHeight);
    const transcriptPadding = Math.max(0, transcriptHeight - visibleTranscript.length);
    const status = this.getStatus();
    const previousFocused = this.input.focused;
    this.input.focused = false;
    const inputLine = this.input.render(innerWidth)[0] ?? "";
    this.input.focused = previousFocused;
    const lines = [
      this.borderLine(innerWidth, "top"),
      this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
      this.frameLine(this.theme.fg("dim", "Separate side conversation. Esc closes."), innerWidth),
      this.theme.fg("borderMuted", `\u251C${"\u2500".repeat(innerWidth)}\u2524`)
    ];
    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadding; i++) {
      lines.push(this.frameLine("", innerWidth));
    }
    lines.push(this.theme.fg("borderMuted", `\u251C${"\u2500".repeat(innerWidth)}\u2524`));
    lines.push(this.frameLine(this.theme.fg("warning", status), innerWidth));
    lines.push(
      `${this.theme.fg("borderMuted", "\u2502")}${inputLine}${this.theme.fg("borderMuted", "\u2502")}`
    );
    lines.push(this.frameLine(this.theme.fg("dim", "Enter submit \xB7 Esc close"), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }
};
function btw_default(pi) {
  let thread = [];
  let pendingQuestion = null;
  let pendingAnswer = "";
  let pendingError = null;
  let pendingToolCalls = [];
  let sideBusy = false;
  let overlayStatus = "Ready";
  let overlayDraft = "";
  let overlayRuntime = null;
  let activeSideSession = null;
  let overlayRefreshTimer = null;
  const mdTheme = getMarkdownTheme();
  function getModelKey(ctx) {
    const model = ctx.model;
    return model ? `${model.provider}/${model.id}` : "none";
  }
  function renderMarkdownLines(text, width) {
    if (!text) return [];
    try {
      const md = new Markdown(text, 0, 0, mdTheme);
      return md.render(width);
    } catch {
      return text.split("\n").flatMap((line) => {
        if (!line) return [""];
        const wrapped = [];
        for (let i = 0; i < line.length; i += width) {
          wrapped.push(line.slice(i, i + width));
        }
        return wrapped.length > 0 ? wrapped : [""];
      });
    }
  }
  function formatToolArgs(toolName, args) {
    if (!args || typeof args !== "object") return "";
    const a = args;
    switch (toolName) {
      case "bash":
        return typeof a.command === "string" ? truncateToWidth(a.command.split("\n")[0], 50, "\u2026") : "";
      case "read":
      case "write":
      case "edit":
        return typeof a.path === "string" ? a.path : "";
      default: {
        const first = Object.values(a)[0];
        return typeof first === "string" ? truncateToWidth(first.split("\n")[0], 40, "\u2026") : "";
      }
    }
  }
  function renderToolCallLines(toolCalls, theme, width) {
    const lines = [];
    for (const tc of toolCalls) {
      const icon = tc.status === "running" ? "\u2699" : tc.status === "error" ? "\u2717" : "\u2713";
      const color = tc.status === "error" ? "error" : tc.status === "done" ? "success" : "dim";
      const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", tc.toolName);
      const argsText = tc.args ? theme.fg("dim", ` ${tc.args}`) : "";
      lines.push(truncateToWidth(`  ${label}${argsText}`, width, ""));
    }
    return lines;
  }
  function getTranscriptLines(width, theme) {
    try {
      return getTranscriptLinesInner(width, theme);
    } catch (error) {
      return [theme.fg("error", `Render error: ${error instanceof Error ? error.message : String(error)}`)];
    }
  }
  function getTranscriptLinesInner(width, theme) {
    if (thread.length === 0 && !pendingQuestion && !pendingAnswer && !pendingError) {
      return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
    }
    const lines = [];
    for (const item of thread.slice(-6)) {
      const userText = item.question.trim().split("\n")[0];
      lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "\u2026"));
      lines.push("");
      const mdLines = renderMarkdownLines(item.answer, width);
      lines.push(...mdLines);
      lines.push("");
    }
    if (pendingQuestion) {
      const userText = pendingQuestion.trim().split("\n")[0];
      lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "\u2026"));
      if (pendingToolCalls.length > 0) {
        lines.push(...renderToolCallLines(pendingToolCalls, theme, width));
      }
      if (pendingError) {
        lines.push(theme.fg("error", `\u274C ${pendingError}`));
      } else if (pendingAnswer) {
        lines.push("");
        const mdLines = renderMarkdownLines(pendingAnswer, width);
        lines.push(...mdLines);
      } else if (pendingToolCalls.length === 0) {
        lines.push(theme.fg("dim", "\u2026"));
      }
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }
  function syncOverlay() {
    overlayRuntime?.refresh?.();
  }
  function scheduleOverlayRefresh() {
    if (overlayRefreshTimer) {
      return;
    }
    overlayRefreshTimer = setTimeout(() => {
      overlayRefreshTimer = null;
      syncOverlay();
    }, 16);
  }
  function setOverlayStatus(status, throttled = false) {
    overlayStatus = status;
    if (throttled) {
      scheduleOverlayRefresh();
    } else {
      syncOverlay();
    }
  }
  function dismissOverlay() {
    overlayRuntime?.close?.();
    overlayRuntime = null;
    if (overlayRefreshTimer) {
      clearTimeout(overlayRefreshTimer);
      overlayRefreshTimer = null;
    }
  }
  function setOverlayDraft(value) {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }
  async function disposeSideSession() {
    const current = activeSideSession;
    activeSideSession = null;
    if (!current) {
      return;
    }
    try {
      current.unsubscribe();
    } catch {
    }
    try {
      await current.session.abort();
    } catch {
    }
    current.session.dispose();
    if (overlayRefreshTimer) {
      clearTimeout(overlayRefreshTimer);
      overlayRefreshTimer = null;
    }
  }
  async function resetThread(ctx, persist = true) {
    thread = [];
    pendingQuestion = null;
    pendingAnswer = "";
    pendingError = null;
    pendingToolCalls = [];
    sideBusy = false;
    setOverlayDraft("");
    setOverlayStatus("Ready");
    await disposeSideSession();
    if (persist) {
      const details = { timestamp: Date.now() };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncOverlay();
  }
  async function restoreThread(ctx) {
    await disposeSideSession();
    thread = [];
    pendingQuestion = null;
    pendingAnswer = "";
    pendingError = null;
    pendingToolCalls = [];
    sideBusy = false;
    overlayStatus = "Ready";
    overlayDraft = "";
    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    for (let i = 0; i < branch.length; i++) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === BTW_RESET_TYPE) {
        lastResetIndex = i;
      }
    }
    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) {
        continue;
      }
      const details = entry.data;
      if (!details?.question || !details.answer) {
        continue;
      }
      thread.push(details);
    }
    syncOverlay();
  }
  async function createSideSession(ctx) {
    if (!ctx.model) {
      return null;
    }
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      cwd: ctx.cwd,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
      tools: ["read", "bash", "edit", "write"],
      resourceLoader: createBtwResourceLoader(ctx)
    });
    const seedMessages = buildSeedMessages(ctx, thread);
    if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages;
    }
    const unsubscribe = session.subscribe((event) => {
      if (!sideBusy || !pendingQuestion) {
        return;
      }
      switch (event.type) {
        case "message_start":
        case "message_update":
        case "message_end": {
          const streamed = extractEventAssistantText(event.message);
          if (streamed) {
            pendingAnswer = streamed;
            pendingError = null;
          }
          setOverlayStatus(event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...", true);
          return;
        }
        case "tool_execution_start": {
          const toolName = event.toolName ?? "unknown";
          try {
            pendingToolCalls.push({
              toolCallId: event.toolCallId ?? "",
              toolName,
              args: formatToolArgs(toolName, event.args),
              status: "running"
            });
          } catch {
          }
          setOverlayStatus(`Running tool: ${toolName}...`, true);
          return;
        }
        case "tool_execution_end": {
          const endToolName = event.toolName ?? "unknown";
          const tc = pendingToolCalls.find(
            (t) => t.toolName === endToolName && t.status === "running"
          );
          if (tc) {
            tc.status = event.isError ? "error" : "done";
          }
          setOverlayStatus("Streaming side response...", true);
          return;
        }
        case "turn_end": {
          setOverlayStatus("Finalizing side response...", true);
          return;
        }
        default:
          return;
      }
    });
    return {
      session,
      modelKey: getModelKey(ctx),
      unsubscribe
    };
  }
  async function ensureSideSession(ctx) {
    if (!ctx.model) {
      return null;
    }
    const expectedModelKey = getModelKey(ctx);
    if (activeSideSession && activeSideSession.modelKey === expectedModelKey) {
      return activeSideSession;
    }
    await disposeSideSession();
    activeSideSession = await createSideSession(ctx);
    return activeSideSession;
  }
  async function ensureOverlay(ctx) {
    if (!ctx.hasUI) {
      return;
    }
    if (overlayRuntime?.handle) {
      overlayRuntime.handle.setHidden(false);
      overlayRuntime.handle.focus();
      overlayRuntime.refresh?.();
      return;
    }
    const runtime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };
    runtime.close = closeRuntime;
    overlayRuntime = runtime;
    void ctx.ui.custom(
      async (tui, theme, keybindings, done) => {
        runtime.finish = () => done();
        const overlay = new BtwOverlay(
          tui,
          theme,
          keybindings,
          (width, t) => getTranscriptLines(width, t),
          () => overlayStatus,
          (value) => {
            void submitFromOverlay(ctx, value);
          },
          () => {
            void closeOverlayFlow(ctx);
          }
        );
        overlay.focused = true;
        overlay.setDraft(overlayDraft);
        runtime.setDraft = (value) => overlay.setDraft(value);
        runtime.refresh = () => {
          overlay.focused = runtime.handle?.isFocused() ?? false;
          tui.requestRender();
        };
        runtime.close = () => {
          overlayDraft = overlay.getDraft();
          closeRuntime();
        };
        if (runtime.closed) {
          done();
        }
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%",
          minWidth: 72,
          maxHeight: "78%",
          anchor: "top-center",
          margin: { top: 1, left: 2, right: 2 }
        },
        onHandle: (handle) => {
          runtime.handle = handle;
          handle.focus();
          if (runtime.closed) {
            closeRuntime();
          }
        }
      }
    ).catch((error) => {
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    });
  }
  async function summarizeThread(ctx, items) {
    const model = ctx.model;
    if (!model) {
      throw new Error("No active model selected.");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
      throw new Error(auth.error);
    }
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      cwd: ctx.cwd,
      model,
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT])
    });
    try {
      await session.prompt(formatThread(items), { source: "extension" });
      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("Summary finished without a response.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("Summary request was aborted.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Summary request failed.");
      }
      return extractText(response.content) || "(No summary generated)";
    } finally {
      try {
        await session.abort();
      } catch {
      }
      session.dispose();
    }
  }
  async function injectSummaryIntoMain(ctx) {
    if (thread.length === 0) {
      notify(ctx, "No BTW thread to summarize.", "warning");
      return;
    }
    setOverlayStatus("Summarizing BTW thread for injection...");
    try {
      const summary = await summarizeThread(ctx, thread);
      const message = `Summary of my BTW side conversation:

${summary}`;
      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
      } else {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      }
      await resetThread(ctx);
      notify(ctx, "Injected BTW summary into main chat.", "info");
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  }
  async function closeOverlayFlow(ctx) {
    dismissOverlay();
    if (!ctx.hasUI) {
      return;
    }
    if (thread.length === 0) {
      return;
    }
    const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
    if (choice === "Inject summary into main chat") {
      await injectSummaryIntoMain(ctx);
    }
  }
  async function runBtwPrompt(ctx, question) {
    const model = ctx.model;
    if (!model) {
      setOverlayStatus("No active model selected.");
      notify(ctx, "No active model selected.", "error");
      return;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) {
      const message = auth.error;
      setOverlayStatus(message);
      notify(ctx, message, "error");
      return;
    }
    if (sideBusy) {
      notify(ctx, "BTW is still processing the previous message.", "warning");
      return;
    }
    const side = await ensureSideSession(ctx);
    if (!side) {
      notify(ctx, "Unable to create BTW side session.", "error");
      return;
    }
    sideBusy = true;
    pendingQuestion = question;
    pendingAnswer = "";
    pendingError = null;
    pendingToolCalls = [];
    setOverlayStatus("Streaming side response...");
    syncOverlay();
    try {
      await side.session.prompt(question, { source: "extension" });
      const response = getLastAssistantMessage(side.session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW request aborted.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }
      const answer = extractText(response.content) || "(No text response)";
      pendingAnswer = answer;
      const details = {
        question,
        answer,
        timestamp: Date.now(),
        provider: model.provider,
        model: model.id,
        thinkingLevel: pi.getThinkingLevel(),
        usage: response.usage
      };
      thread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);
      pendingQuestion = null;
      pendingAnswer = "";
      pendingToolCalls = [];
      setOverlayStatus("Ready for the next side question.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pendingError = message;
      setOverlayStatus("BTW request failed.");
      notify(ctx, message, "error");
    } finally {
      sideBusy = false;
      syncOverlay();
    }
  }
  async function submitFromOverlay(ctx, rawValue) {
    const question = rawValue.trim();
    if (!question) {
      setOverlayStatus("Enter a question first.");
      return;
    }
    setOverlayDraft("");
    if (!("waitForIdle" in ctx)) {
      setOverlayStatus("BTW submit requires command context. Re-open with /btw.");
      return;
    }
    await runBtwPrompt(ctx, question);
  }
  pi.registerCommand("btw", {
    description: "Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        if (thread.length > 0 && ctx.hasUI) {
          const choice = await ctx.ui.select("BTW side chat:", [
            "Continue previous conversation",
            "Start fresh"
          ]);
          if (choice === "Continue previous conversation") {
            await disposeSideSession();
            setOverlayStatus("Continuing BTW thread.");
            await ensureOverlay(ctx);
          } else if (choice === "Start fresh") {
            await resetThread(ctx, true);
            setOverlayStatus("Ready");
            await ensureOverlay(ctx);
          }
        } else {
          await resetThread(ctx, true);
          setOverlayStatus("Ready");
          await ensureOverlay(ctx);
        }
        return;
      }
      await ensureOverlay(ctx);
      await runBtwPrompt(ctx, question);
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });
  pi.on("session_shutdown", async () => {
    await disposeSideSession();
    dismissOverlay();
  });
}
export {
  btw_default as default
};
//# sourceMappingURL=btw.js.map
