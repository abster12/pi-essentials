// src/usage-tracker.ts
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
var OPENCODE_GO_USAGE = "https://opencode.ai/zen/go/v1/usage";
var XAI_BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
var XAI_SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings";
var CACHE_MS = 6e4;
var WARN_AT = 80;
var PROVIDERS = [
  { id: "opencode-go", short: "go", name: "OpenCode Go", fetch: fetchOpencodeGo },
  { id: "opencode", short: "zen", name: "OpenCode Zen" },
  { id: "cursor", short: "cursor", name: "Cursor" },
  { id: "xai", short: "xai", name: "xAI", fetch: fetchXai }
];
function parseOpencodeUsage(json) {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") throw new Error("bad usage payload");
  const out = [];
  for (const name of ["rolling", "weekly", "monthly"]) {
    const w = usage[name];
    if (!w || typeof w !== "object") continue;
    const rec = w;
    const percent = Number(rec.percent);
    if (!Number.isFinite(percent)) continue;
    out.push({
      name,
      percent,
      status: typeof rec.status === "string" ? rec.status : "ok",
      resetsAt: typeof rec.resetsAt === "string" ? rec.resetsAt : void 0
    });
  }
  if (out.length === 0) throw new Error("no usage windows");
  return out;
}
async function fetchOpencodeGo(apiKey, signal) {
  const res = await fetch(OPENCODE_GO_USAGE, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseOpencodeUsage(await res.json());
}
function money(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "val" in v) {
    const n = Number(v.val);
    return Number.isFinite(n) ? n : void 0;
  }
  return void 0;
}
function parseXaiTier(json) {
  const t = json?.subscription_tier_display;
  return typeof t === "string" && t.trim() ? t.trim() : void 0;
}
function currentOnDemandUsed(rec) {
  const direct = money(rec.onDemandUsed);
  if (direct !== void 0) return direct;
  const end = typeof rec.billingPeriodEnd === "string" ? rec.billingPeriodEnd : void 0;
  const y = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(y) || !Array.isArray(rec.history)) return void 0;
  const d = new Date(y);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  for (const row of rec.history) {
    if (!row || typeof row !== "object") continue;
    const cycle = row.billingCycle;
    if (cycle?.year === year && cycle?.month === month) return money(row.onDemandUsed);
  }
  return void 0;
}
function parseXaiBilling(json, tier) {
  const config = json?.config;
  if (!config || typeof config !== "object") throw new Error("bad billing payload");
  const rec = config;
  const resetsAt = typeof rec.billingPeriodEnd === "string" ? rec.billingPeriodEnd : void 0;
  const out = [];
  if (tier) out.push({ name: "plan", percent: 0, status: "ok", text: tier });
  const creditPct = Number(rec.creditUsagePercent);
  if (Number.isFinite(creditPct)) {
    const period = rec.currentPeriod && typeof rec.currentPeriod === "object" ? rec.currentPeriod : void 0;
    const kind = typeof period?.type === "string" ? period.type : "";
    const name = kind.includes("WEEKLY") ? "weekly" : kind.includes("MONTHLY") ? "monthly" : "credits";
    const end = typeof period?.end === "string" ? period.end : resetsAt;
    out.push({ name, percent: creditPct, status: "ok", resetsAt: end });
  }
  const prepaid = money(rec.prepaidBalance);
  if (prepaid !== void 0 && prepaid > 0) {
    out.push({ name: "credits", percent: 0, status: "ok", text: `$${prepaid}` });
  }
  const used = money(rec.used);
  const limit = money(rec.monthlyLimit) ?? 0;
  if (used !== void 0 && limit > 0) {
    out.push({ name: "monthly", percent: used / limit * 100, status: "ok", resetsAt });
  }
  const cap = money(rec.onDemandCap) ?? 0;
  const odUsed = currentOnDemandUsed(rec);
  if (cap > 0 && odUsed !== void 0) {
    out.push({ name: "on-demand", percent: odUsed / cap * 100, status: "ok", resetsAt });
  }
  if (out.length === 0) throw new Error("no usage windows");
  return out;
}
async function fetchXai(apiKey, signal) {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const [billing, settings] = await Promise.all([
    fetch(XAI_BILLING, { headers, signal }),
    fetch(XAI_SETTINGS, { headers, signal })
  ]);
  if (!billing.ok) throw new Error(`HTTP ${billing.status}`);
  const tier = settings.ok ? parseXaiTier(await settings.json()) : void 0;
  return parseXaiBilling(await billing.json(), tier);
}
function hottest(windows) {
  return windows.reduce((a, b) => b.percent > a.percent ? b : a);
}
function remaining(percent) {
  return Math.max(0, Math.round((100 - percent) * 10) / 10);
}
function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(percent / 100 * width)));
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}
function until(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  if (ms < 36e5) return `${Math.ceil(ms / 6e4)}m`;
  if (ms < 864e5) return `${Math.ceil(ms / 36e5)}h`;
  return `${Math.ceil(ms / 864e5)}d`;
}
function formatFooter(rows) {
  return rows.flatMap((r) => {
    if (r.kind !== "ok") return [];
    const metered = r.windows.filter((w) => !w.text);
    if (metered.length > 0) {
      const w = hottest(metered);
      return [`${r.short}-${w.name} ${Math.round(w.percent)}%`];
    }
    const text = r.windows[0]?.text;
    return [text ? `${r.short} ${text}` : r.short];
  }).join(" \xB7 ");
}
function formatReport(rows, now = Date.now()) {
  if (rows.length === 0) return "No linked subscriptions.";
  const parts = ["**Subscription usage**", ""];
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
          `  ${w.name.padEnd(9)} [${bar(w.percent)}]  ${Math.round(w.percent)}% used  ${remaining(w.percent)}% left${reset}`
        );
      }
    } else if (r.kind === "unsupported") {
      parts.push("  linked \u2014 no remaining-quota API");
    } else {
      parts.push(`  error: ${r.error}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}
function usage_tracker_default(pi) {
  let cache;
  const warned = /* @__PURE__ */ new Set();
  async function collect(ctx, signal) {
    const rows = [];
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
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    return rows;
  }
  async function load(ctx, force = false) {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const rows = await collect(ctx);
    cache = { at: Date.now(), rows };
    return rows;
  }
  function hide(ctx) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("usage", void 0);
  }
  function paint(ctx, rows) {
    if (!ctx.hasUI) return;
    const line = formatFooter(rows);
    ctx.ui.setStatus("usage", line || void 0);
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
  async function refresh(ctx, force = false) {
    const rows = await load(ctx, force);
    paint(ctx, rows);
    return rows;
  }
  pi.registerEntryRenderer("usage", (entry) => new Text(typeof entry.data === "string" ? entry.data : "", 0, 0));
  pi.on("session_start", async (_event, ctx) => {
    try {
      await refresh(ctx);
    } catch {
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    cache = void 0;
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
    }
  });
  pi.registerTool({
    name: "usage_tracker",
    label: "Usage tracker",
    description: "Remaining subscription quota for providers linked in pi (used % / left % / reset). Not token spend \u2014 use token_tracker for that.",
    promptGuidelines: [
      "Answer remaining-quota / 'how much of my plan is left' questions with usage_tracker, not token_tracker."
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const rows = await collect(ctx, signal);
      return { content: [{ type: "text", text: formatReport(rows) }], details: {} };
    }
  });
}
export {
  PROVIDERS,
  bar,
  usage_tracker_default as default,
  formatFooter,
  formatReport,
  hottest,
  parseOpencodeUsage,
  parseXaiBilling,
  parseXaiTier,
  remaining,
  until
};
//# sourceMappingURL=usage-tracker.js.map
