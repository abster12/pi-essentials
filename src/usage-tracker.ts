/**
 * usage_tracker — remaining subscription quota for providers linked in pi.
 *
 * OpenCode Go: GET /zen/go/v1/usage. xAI: grok CLI billing proxy
 * (plan + monthly/on-demand). OpenAI Codex: GET /wham/usage (5h + weekly).
 * Cursor has no remaining-quota API.
 * `/usage` prints a report (not sent to the model). Footer shows `go-weekly 40% · xai SuperGrok · oai-5h 48% · oai-weekly 7%`.
 * `/tokens` is spend; this is remaining allowance.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

export type QuotaWindow = {
  name: string;
  percent: number;
  status: string;
  resetsAt?: string;
  /** Unmetered row (plan name, prepaid credits). Printed instead of a % bar. */
  text?: string;
};

export type ProviderRow =
  | { id: string; short: string; name: string; kind: "ok"; windows: QuotaWindow[] }
  | { id: string; short: string; name: string; kind: "unsupported" }
  | { id: string; short: string; name: string; kind: "error"; error: string };

type Fetcher = (apiKey: string, signal?: AbortSignal) => Promise<QuotaWindow[]>;

type ProviderDef = {
  id: string;
  short: string;
  name: string;
  fetch?: Fetcher;
};

const OPENCODE_GO_USAGE = "https://opencode.ai/zen/go/v1/usage";
// ponytail: grok CLI proxy, official remaining-quota API if xAI publishes one
const XAI_BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings";
// ponytail: chatgpt.com/wham/usage, official remaining-quota API if OpenAI publishes one
const OPENAI_CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const CACHE_MS = 60_000;
const WARN_AT = 80;

export const PROVIDERS: ProviderDef[] = [
  { id: "opencode-go", short: "go", name: "OpenCode Go", fetch: fetchOpencodeGo },
  { id: "opencode", short: "zen", name: "OpenCode Zen" },
  { id: "cursor", short: "cursor", name: "Cursor" },
  { id: "xai", short: "xai", name: "xAI", fetch: fetchXai },
  { id: "openai-codex", short: "oai", name: "OpenAI Codex", fetch: fetchOpenAICodex },
];

export function parseOpencodeUsage(json: unknown): QuotaWindow[] {
  const usage = (json as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") throw new Error("bad usage payload");
  const out: QuotaWindow[] = [];
  for (const name of ["rolling", "weekly", "monthly"] as const) {
    const w = (usage as Record<string, unknown>)[name];
    if (!w || typeof w !== "object") continue;
    const rec = w as Record<string, unknown>;
    const percent = Number(rec.percent);
    if (!Number.isFinite(percent)) continue;
    out.push({
      name,
      percent,
      status: typeof rec.status === "string" ? rec.status : "ok",
      resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : undefined,
    });
  }
  if (out.length === 0) throw new Error("no usage windows");
  return out;
}

async function fetchOpencodeGo(apiKey: string, signal?: AbortSignal): Promise<QuotaWindow[]> {
  const res = await fetch(OPENCODE_GO_USAGE, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOpencodeUsage(await res.json());
}

function money(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "val" in v) {
    const n = Number((v as { val: unknown }).val);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function parseXaiTier(json: unknown): string | undefined {
  const t = (json as { subscription_tier_display?: unknown } | null)?.subscription_tier_display;
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

function currentOnDemandUsed(rec: Record<string, unknown>): number | undefined {
  const direct = money(rec.onDemandUsed);
  if (direct !== undefined) return direct;
  const end = typeof rec.billingPeriodEnd === "string" ? rec.billingPeriodEnd : undefined;
  const y = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(y) || !Array.isArray(rec.history)) return undefined;
  // period end is the 1st of next month; history.month is 1-based calendar month
  const d = new Date(y);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  for (const row of rec.history) {
    if (!row || typeof row !== "object") continue;
    const cycle = (row as { billingCycle?: { year?: unknown; month?: unknown } }).billingCycle;
    if (cycle?.year === year && cycle?.month === month) return money((row as { onDemandUsed?: unknown }).onDemandUsed);
  }
  return undefined;
}

export function parseXaiBilling(json: unknown, tier?: string): QuotaWindow[] {
  const config = (json as { config?: unknown } | null)?.config;
  if (!config || typeof config !== "object") throw new Error("bad billing payload");
  const rec = config as Record<string, unknown>;
  const resetsAt = typeof rec.billingPeriodEnd === "string" ? rec.billingPeriodEnd : undefined;
  const out: QuotaWindow[] = [];
  if (tier) out.push({ name: "plan", percent: 0, status: "ok", text: tier });
  const creditPct = Number(rec.creditUsagePercent);
  if (Number.isFinite(creditPct)) {
    const period = rec.currentPeriod && typeof rec.currentPeriod === "object" ? (rec.currentPeriod as Record<string, unknown>) : undefined;
    const kind = typeof period?.type === "string" ? period.type : "";
    const name = kind.includes("WEEKLY") ? "weekly" : kind.includes("MONTHLY") ? "monthly" : "credits";
    const end = typeof period?.end === "string" ? period.end : resetsAt;
    out.push({ name, percent: creditPct, status: "ok", resetsAt: end });
  }
  const prepaid = money(rec.prepaidBalance);
  if (prepaid !== undefined && prepaid > 0) {
    out.push({ name: "credits", percent: 0, status: "ok", text: `$${prepaid}` });
  }
  const used = money(rec.used);
  const limit = money(rec.monthlyLimit) ?? 0;
  if (used !== undefined && limit > 0) {
    out.push({ name: "monthly", percent: (used / limit) * 100, status: "ok", resetsAt });
  }
  const cap = money(rec.onDemandCap) ?? 0;
  const odUsed = currentOnDemandUsed(rec);
  if (cap > 0 && odUsed !== undefined) {
    out.push({ name: "on-demand", percent: (odUsed / cap) * 100, status: "ok", resetsAt });
  }
  if (out.length === 0) throw new Error("no usage windows");
  return out;
}

async function fetchXai(apiKey: string, signal?: AbortSignal): Promise<QuotaWindow[]> {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const [billing, settings] = await Promise.all([
    fetch(XAI_BILLING, { headers, signal }),
    fetch(XAI_SETTINGS, { headers, signal }),
  ]);
  if (!billing.ok) throw new Error(`HTTP ${billing.status}`);
  const tier = settings.ok ? parseXaiTier(await settings.json()) : undefined;
  return parseXaiBilling(await billing.json(), tier);
}

function durationName(seconds: number): string {
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "weekly";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds)}s`;
}

function unixIso(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

function parseCodexWindow(rec: unknown, fallback: string): QuotaWindow | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  const row = rec as Record<string, unknown>;
  const percent = Number(row.used_percent);
  if (!Number.isFinite(percent)) return undefined;
  const seconds = Number(row.limit_window_seconds);
  return {
    name: Number.isFinite(seconds) && seconds > 0 ? durationName(seconds) : fallback,
    percent,
    status: "ok",
    resetsAt: unixIso(row.reset_at),
  };
}

export function parseOpenAICodexUsage(json: unknown): QuotaWindow[] {
  if (!json || typeof json !== "object") throw new Error("bad usage payload");
  const rec = json as Record<string, unknown>;
  const out: QuotaWindow[] = [];
  if (typeof rec.plan_type === "string" && rec.plan_type.trim()) {
    out.push({ name: "plan", percent: 0, status: "ok", text: rec.plan_type.trim() });
  }
  const rate = rec.rate_limit && typeof rec.rate_limit === "object" ? (rec.rate_limit as Record<string, unknown>) : undefined;
  const primary = parseCodexWindow(rate?.primary_window, "primary");
  const secondary = parseCodexWindow(rate?.secondary_window, "secondary");
  if (primary) out.push(primary);
  if (secondary) out.push(secondary);
  if (out.length === 0) throw new Error("no usage windows");
  return out;
}

function accountIdFromToken(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("no account id");
  const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const auth = json[OPENAI_AUTH_CLAIM];
  const id = auth && typeof auth === "object" ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
  if (typeof id !== "string" || !id) throw new Error("no account id");
  return id;
}

async function fetchOpenAICodex(apiKey: string, signal?: AbortSignal): Promise<QuotaWindow[]> {
  const res = await fetch(OPENAI_CODEX_USAGE, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "chatgpt-account-id": accountIdFromToken(apiKey),
      Accept: "application/json",
      originator: "pi",
    },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOpenAICodexUsage(await res.json());
}

/** Hottest window = highest used %. */
export function hottest(windows: QuotaWindow[]): QuotaWindow {
  return windows.reduce((a, b) => (b.percent > a.percent ? b : a));
}

export function remaining(percent: number): number {
  return Math.max(0, Math.round((100 - percent) * 10) / 10);
}

export function bar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Compact remaining time until an ISO timestamp. */
export function until(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.ceil(ms / 86_400_000)}d`;
}

export function formatFooter(rows: ProviderRow[]): string {
  return rows
    .flatMap((r) => {
      if (r.kind !== "ok") return [];
      const metered = r.windows.filter((w) => !w.text);
      if (metered.length > 0) {
        // 5h and weekly are independent limits — both belong in the footer
        const shown = r.id === "openai-codex" ? metered : [hottest(metered)];
        return shown.map((w) => `${r.short}-${w.name} ${Math.round(w.percent)}%`);
      }
      const text = r.windows[0]?.text;
      return [text ? `${r.short} ${text}` : r.short];
    })
    .join(" · ");
}

export function formatReport(rows: ProviderRow[], now = Date.now()): string {
  if (rows.length === 0) return "No linked subscriptions.";
  const parts: string[] = ["**Subscription usage**", ""];
  for (const r of rows) {
    parts.push(`**${r.name}**`);
    if (r.kind === "ok") {
      for (const w of r.windows) {
        if (w.text) {
          parts.push(`  ${w.name.padEnd(9)}  ${w.text}`);
          continue;
        }
        const reset = w.resetsAt ? `  resets ${until(w.resetsAt, now)}` : "";
        parts.push(
          `  ${w.name.padEnd(9)} [${bar(w.percent)}]  ${Math.round(w.percent)}% used  ${remaining(w.percent)}% left${reset}`,
        );
      }
    } else if (r.kind === "unsupported") {
      parts.push("  linked — no remaining-quota API");
    } else {
      parts.push(`  error: ${r.error}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

export default function (pi: ExtensionAPI) {
  let cache: { at: number; rows: ProviderRow[] } | undefined;
  const warned = new Set<string>();

  async function collect(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderRow[]> {
    const rows: ProviderRow[] = [];
    for (const def of PROVIDERS) {
      const status = ctx.modelRegistry.getProviderAuthStatus(def.id);
      if (!status.configured) continue;
      if (!def.fetch) {
        rows.push({ id: def.id, short: def.short, name: def.name, kind: "unsupported" });
        continue;
      }
      try {
        const auth = await ctx.modelRegistry.getProviderAuth(def.id);
        const key = auth?.auth.apiKey;
        if (!key) throw new Error("no api key");
        const windows = await def.fetch(key, signal);
        rows.push({ id: def.id, short: def.short, name: def.name, kind: "ok", windows });
      } catch (e) {
        rows.push({
          id: def.id,
          short: def.short,
          name: def.name,
          kind: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return rows;
  }

  async function load(ctx: ExtensionContext, force = false): Promise<ProviderRow[]> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const rows = await collect(ctx);
    cache = { at: Date.now(), rows };
    return rows;
  }

  function hide(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("usage", undefined);
  }

  function paint(ctx: ExtensionContext, rows: ProviderRow[]): void {
    if (!ctx.hasUI) return;
    const line = formatFooter(rows);
    ctx.ui.setStatus("usage", line || undefined);
    for (const r of rows) {
      if (r.kind !== "ok") continue;
      for (const w of r.windows) {
        if (w.text) continue;
        const key = `${r.id}:${w.name}`;
        if (w.percent >= WARN_AT && !warned.has(key)) {
          warned.add(key);
          ctx.ui.notify(`${r.name} ${w.name} at ${Math.round(w.percent)}% used`, "warning");
        }
      }
    }
  }

  async function refresh(ctx: ExtensionContext, force = false): Promise<ProviderRow[]> {
    const rows = await load(ctx, force);
    paint(ctx, rows);
    return rows;
  }

  pi.registerEntryRenderer("usage", (entry) => new Text(typeof entry.data === "string" ? entry.data : "", 0, 0));

  pi.on("session_start", async (_event, ctx) => {
    try {
      await refresh(ctx);
    } catch {
      /* footer stays empty */
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cache = undefined;
    hide(ctx);
  });

  pi.registerCommand("usage", {
    description: "Show remaining subscription quota. /usage hide clears the footer.",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "hide") {
        hide(ctx);
        return;
      }
      try {
        const rows = await refresh(ctx, true);
        pi.appendEntry("usage", formatReport(rows));
      } catch (e) {
        ctx.ui.notify(`usage failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "usage_tracker",
    label: "Usage tracker",
    description:
      "Remaining subscription quota for providers linked in pi (used % / left % / reset). Not token spend — use token_tracker for that.",
    promptGuidelines: [
      "Answer remaining-quota / 'how much of my plan is left' questions with usage_tracker, not token_tracker.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const rows = await collect(ctx, signal);
      return { content: [{ type: "text", text: formatReport(rows) }], details: {} };
    },
  });
}
