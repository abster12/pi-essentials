/**
 * token_tracker — per-model token usage and cost, aggregated from the two
 * streams that burn tokens on this machine.
 *
 * Stream 1 — pi sessions. Every assistant message in a pi session transcript
 * (JSONL files under ~/.pi/agent/sessions and ~/.pi/agent/subagent-sessions,
 * both recursive) carries provider/model/usage {input, output, cacheRead,
 * cacheWrite, reasoning, totalTokens, cost}. We scan those files and aggregate
 * per model. This covers everything pi itself ever spent, whatever provider it
 * uses.
 *
 * Stream 2 — opencode. The opencode CLI keeps its own session ledger in SQLite
 * (~/.local/share/opencode/opencode.db): a `session` row per run with model,
 * cost and token columns — the data behind `opencode stats`. We query it
 * directly via node:sqlite. Note pi's opencode-go provider hits the hosted
 * API directly, so its tokens appear in stream 1, NOT in opencode's local DB:
 * the two streams are distinct and are reported as separate sections.
 *
 * node:sqlite needs Node ≥22.5; the require is lazy so the extension still
 * loads on older nodes (the opencode section then reports the requirement).
 * The ExperimentalWarning node prints on first use is harmless.
 *
 * Surface: `/tokens [--days N] [--source pi|opencode|all]` command and a
 * `token_tracker` tool (same report) so the model can answer usage questions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Aggregate totals for one model within one source stream. */
export type ModelTotals = {
  msgs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
};

/** Minimal shape of the sqlite surface we use (node:sqlite DatabaseSync). */
export type SqlDb = {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
};

/** A per-model row from the opencode `session` table. */
export type OpencodeRow = {
  model: string;
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
};

/** Command args: `/tokens [--days N] [--source pi|opencode|all]`. */
export type TokenArgs = { days?: number; source?: "pi" | "opencode" | "all" };

const MS_PER_DAY = 86_400_000;

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Parse `/tokens` args; unknown flags/values throw with the usage line. */
export function parseArgs(raw: string): TokenArgs {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const out: TokenArgs = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--days") {
      const v = Number(tokens[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error("--days needs a non-negative number (e.g. /tokens --days 7)");
      if (v > 0) out.days = Math.floor(v);
    } else if (t === "--source") {
      const v = tokens[++i];
      if (v !== "pi" && v !== "opencode" && v !== "all") {
        throw new Error("--source must be pi, opencode, or all");
      }
      out.source = v;
    } else {
      throw new Error(`Unknown argument "${t}" — usage: /tokens [--days N] [--source pi|opencode|all]`);
    }
  }
  return out;
}

/** Epoch ms cutoff for a "last N days" window; undefined = all time. */
export function daysCutoff(days: number | undefined, now = Date.now()): number | undefined {
  return days !== undefined && days > 0 ? now - days * MS_PER_DAY : undefined;
}

/** Where opencode keeps its SQLite ledger. Honors OPENCODE_DATA_DIR and
 *  XDG_DATA_HOME; defaults to ~/.local/share/opencode. */
export function resolveOpencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCODE_DATA_DIR?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  return join(homedir(), ".local", "share", "opencode");
}

/** Where pi session transcripts live (override via PI_AGENT_DIR). */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** All *.jsonl under dir (recursively), sorted for deterministic output. */
export function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir → no files
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function addAssistantUsage(m: unknown, totals: Map<string, ModelTotals>): void {
  const msg = (m ?? {}) as Record<string, unknown>;
  if (msg.role !== "assistant" || typeof msg.provider !== "string" || typeof msg.model !== "string") return;
  const usage = msg.usage;
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  // A real usage record carries at least one of these — reject empty objects
  // so an assistant message without usage never gets counted as a billed call.
  if (!("input" in u) && !("output" in u) && !("totalTokens" in u)) return;
  const model = `${msg.provider}/${msg.model}`;
  let t = totals.get(model);
  if (!t) {
    t = { msgs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
    totals.set(model, t);
  }
  t.msgs++;
  t.input += num(u.input);
  t.output += num(u.output);
  t.cacheRead += num(u.cacheRead);
  t.cacheWrite += num(u.cacheWrite);
  t.reasoning += num(u.reasoning);
  const cost = (u.cost ?? {}) as Record<string, unknown>;
  t.cost += num(cost.total);
}

/** Aggregate one pi transcript (JSONL text). A file whose session header
 *  timestamp predates the cutoff is skipped wholesale. Malformed lines are
 *  ignored — the live session file is being appended to as we read it. */
export function aggregatePiFileText(
  text: string,
  cutoffMs: number | undefined,
): { skipped: boolean; totals: Map<string, ModelTotals> } {
  const totals = new Map<string, ModelTotals>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: Record<string, unknown> | null;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj) continue;
    if (i === 0 && obj.type === "session") {
      const ts = Date.parse(String(obj.timestamp ?? ""));
      if (cutoffMs !== undefined && Number.isFinite(ts) && ts < cutoffMs) {
        return { skipped: true, totals };
      }
      continue;
    }
    if (obj.type === "compaction" && Array.isArray(obj.retainedTail)) {
      for (const m of obj.retainedTail as unknown[]) addAssistantUsage(m, totals);
    } else {
      addAssistantUsage((obj.message ?? {}) as unknown, totals);
    }
  }
  return { skipped: false, totals };
}

function mergeTotals(target: Map<string, ModelTotals>, model: string, t: ModelTotals): void {
  const cur = target.get(model);
  if (!cur) {
    target.set(model, { ...t });
    return;
  }
  for (const k of ["msgs", "input", "output", "cacheRead", "cacheWrite", "reasoning", "cost"] as const) {
    cur[k] += t[k];
  }
}

/** Aggregate every pi transcript under dirs, honoring the time window. */
export function aggregatePiFiles(
  files: string[],
  cutoffMs: number | undefined,
): { included: number; totals: Map<string, ModelTotals> } {
  const totals = new Map<string, ModelTotals>();
  let included = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const r = aggregatePiFileText(text, cutoffMs);
    if (r.skipped) continue;
    included++;
    for (const [model, t] of r.totals) mergeTotals(totals, model, t);
  }
  return { included, totals };
}

/** Open opencode's SQLite ledger (lazy node:sqlite so old nodes still load
 *  the extension). Throws with a friendly message when sqlite is missing. */
export function openOpencodeDb(dataDir: string): SqlDb {
  let sqlite: typeof import("node:sqlite");
  try {
    const req = createRequire(import.meta.url);
    sqlite = req("node:sqlite") as typeof import("node:sqlite");
  } catch {
    throw new Error("node:sqlite unavailable — opencode tracking needs Node ≥ 22.5");
  }
  return new sqlite.DatabaseSync(join(dataDir, "opencode.db")) as unknown as SqlDb;
}

/** opencode's `session.model` is a JSON string like
 *  {"id":"qwen3.7-max","providerID":"opencode-go","variant":"default"}.
 *  Parse it to `providerID/id` (what `opencode stats --models` shows),
 *  merging variants of the same model. Plain model names pass through. */
export function opencodeModelName(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as { id?: unknown; providerID?: unknown };
      if (o && typeof o.id === "string" && o.id) {
        const provider = typeof o.providerID === "string" && o.providerID ? o.providerID : "opencode";
        return `${provider}/${o.id}`;
      }
    } catch {
      /* fall through to raw string */
    }
  }
  return s || "unknown";
}

/** Per-model usage from opencode's session ledger, sorted by cost. The raw
 *  rows are grouped by their JSON model string first, then merged on the
 *  parsed provider/id so variants collapse into one line. */
export function aggregateOpencodeSessions(db: SqlDb, cutoffMs: number | undefined): OpencodeRow[] {
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*)                                   AS sessions,
              SUM(COALESCE(tokens_input, 0))             AS input,
              SUM(COALESCE(tokens_output, 0))            AS output,
              SUM(COALESCE(tokens_reasoning, 0))         AS reasoning,
              SUM(COALESCE(tokens_cache_read, 0))        AS cacheRead,
              SUM(COALESCE(tokens_cache_write, 0))       AS cacheWrite,
              SUM(COALESCE(cost, 0))                     AS cost
       FROM session
       WHERE model IS NOT NULL AND (?1 IS NULL OR time_created >= ?1)
       GROUP BY model`,
    )
    .all(cutoffMs ?? null);
  const merged = new Map<string, OpencodeRow>();
  for (const r of rows) {
    const model = opencodeModelName(r.model);
    let row = merged.get(model);
    if (!row) {
      row = { model, sessions: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      merged.set(model, row);
    }
    row.sessions += num(r.sessions);
    row.input += num(r.input);
    row.output += num(r.output);
    row.reasoning += num(r.reasoning);
    row.cacheRead += num(r.cacheRead);
    row.cacheWrite += num(r.cacheWrite);
    row.cost += num(r.cost);
  }
  return [...merged.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

/** Thousands-separated integer. */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Two decimals above a cent, four below (small per-message costs). */
export function fmtCost(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0.00";
}

/** Aligned text table: model column left, numeric columns right. */
export function formatTable(headers: string[], rows: string[][], rightAlign: boolean[]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (rightAlign[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** The six token/cost cells shared by every table row (no model cell). */
function numCells(t: Pick<ModelTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "cost">): string[] {
  return [
    fmtInt(t.input),
    fmtInt(t.output),
    fmtInt(t.cacheRead),
    fmtInt(t.cacheWrite),
    fmtInt(t.reasoning),
    fmtCost(t.cost),
  ];
}

/** Sum the numeric fields of every row (model names are strings and are
 *  skipped). Works for both pi totals (msgs + token fields) and opencode
 *  rows (sessions + token fields). */
function sumTotals<T extends object>(rows: T[]): T {
  const out: Record<string, number> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as T;
}

/** Build the whole report: pi section, opencode section, combined line. */
export function buildReport(opts: TokenArgs & { agentDir?: string; opencodeDataDir?: string } = {}): string {
  const cutoff = daysCutoff(opts.days);
  const source = opts.source ?? "all";
  const window = cutoff === undefined ? "all time" : `last ${opts.days} day${opts.days === 1 ? "" : "s"}`;
  const parts: string[] = [];
  const opencodeRows: OpencodeRow[] = [];
  let piCombined: ModelTotals | undefined;

  if (source === "pi" || source === "all") {
    const agentDir = opts.agentDir ?? resolvePiAgentDir();
    const files = [
      ...listJsonlFiles(join(agentDir, "sessions")),
      ...listJsonlFiles(join(agentDir, "subagent-sessions")),
    ];
    const { included, totals } = aggregatePiFiles(files, cutoff);
    const rows = [...totals.entries()]
      .map(([model, totals]) => ({ model, totals }))
      .sort((a, b) => b.totals.cost - a.totals.cost || a.model.localeCompare(b.model));
    const headers = ["model", "msgs", "input", "output", "cacheR", "cacheW", "reasoning", "cost"];
    const total = sumTotals(rows.map((r) => r.totals));
    const table =
      rows.length === 0
        ? "_No billed usage in the window._"
        : formatTable(
            headers,
            [
              ...rows.map((r) => [r.model, fmtInt(r.totals.msgs), ...numCells(r.totals)]),
              ["TOTAL", fmtInt(total.msgs), ...numCells(total)],
            ],
            [false, true, true, true, true, true, true, true],
          );
    parts.push(
      `**Token usage — pi sessions** · ${included} file${included === 1 ? "" : "s"} · ${window}\n\n\`\`\`\n${table}\n\`\`\``,
    );
    if (included === 0) parts[parts.length - 1] += "\n\n_No session transcripts found (checked " + agentDir + ")._";
    piCombined = sumTotals(rows.map((r) => r.totals));
  }

  if (source === "opencode" || source === "all") {
    const dataDir = opts.opencodeDataDir ?? resolveOpencodeDataDir();
    try {
      const db = openOpencodeDb(dataDir);
      const rows = aggregateOpencodeSessions(db, cutoff);
      const headers = ["model", "sessions", "input", "output", "cacheR", "cacheW", "reasoning", "cost"];
      const total = sumTotals(rows);
      const table =
        rows.length === 0
          ? "_No sessions in the window._"
          : formatTable(
              headers,
              [
                ...rows.map((r) => [r.model, fmtInt(r.sessions), ...numCells(r)]),
                ["TOTAL", fmtInt(total.sessions), ...numCells(total)],
              ],
              [false, true, true, true, true, true, true, true],
            );
      parts.push(`**Token usage — opencode** · ${dataDir}/opencode.db · ${window}\n\n\`\`\`\n${table}\n\`\`\``);
      opencodeRows.push(...rows);
    } catch (e) {
      parts.push(
        `**Token usage — opencode** · ${window}\n\n_Unavailable: ${e instanceof Error ? e.message : String(e)}_`,
      );
    }
  }

  if (source === "all" && piCombined && opencodeRows.length > 0) {
    const c: ModelTotals = { ...piCombined };
    for (const r of opencodeRows) {
      c.input += r.input;
      c.output += r.output;
      c.cacheRead += r.cacheRead;
      c.cacheWrite += r.cacheWrite;
      c.reasoning += r.reasoning;
      c.cost += r.cost;
    }
    parts.push(
      `**Combined (pi + opencode)** · input ${fmtInt(c.input)} · output ${fmtInt(c.output)} · ` +
        `cache read ${fmtInt(c.cacheRead)} · **${fmtCost(c.cost)} total**`,
    );
  }
  return parts.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "token_tracker",
    label: "Token tracker",
    description:
      "Aggregate LLM token usage and cost per model. Reports pi's own usage (parsed from session transcripts under ~/.pi/agent/sessions and subagent-sessions, per provider/model) and opencode CLI usage (queried directly from opencode's SQLite ledger). " +
      "Use when asked how many tokens or how much money a model/session/week cost.",
    promptGuidelines: [
      "Answer token/cost questions with token_tracker rather than guessing: `days` limits the window (default: all time), `source` picks the stream (pi, opencode, or all — default all).",
    ],
    parameters: Type.Object({
      days: Type.Optional(
        Type.Integer({ description: "Only count usage from the last N days (default: all time)." }),
      ),
      source: Type.Optional(
        Type.Union([Type.Literal("pi"), Type.Literal("opencode"), Type.Literal("all")], {
          description: "Which usage stream to report: pi session transcripts, the opencode ledger, or both (default: all).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const text = buildReport({ days: params.days, source: params.source ?? "all" });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerCommand("tokens", {
    description:
      "Show LLM token usage and cost per model — pi sessions and opencode. Usage: /tokens [--days N] [--source pi|opencode|all]",
    handler: async (args: string, ctx) => {
      try {
        const text = buildReport(parseArgs(args));
        await pi.sendUserMessage(text, { deliverAs: "steer" });
        ctx.ui.notify("tokens: report injected into the conversation", "info");
      } catch (e) {
        ctx.ui.notify(`tokens failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
