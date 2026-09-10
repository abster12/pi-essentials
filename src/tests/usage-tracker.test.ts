import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bar,
  formatFooter,
  formatReport,
  hottest,
  parseOpencodeUsage,
  parseOpenAICodexUsage,
  parseXaiBilling,
  parseXaiTier,
  remaining,
  until,
  type ProviderRow,
  type QuotaWindow,
} from "../usage-tracker.ts";

const sample = {
  usage: {
    rolling: { status: "ok", percent: 12.4, resetsAt: "2026-08-17T15:39:58.755Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2026-08-24T00:00:00.755Z" },
    monthly: { status: "ok", percent: 0, resetsAt: "2026-09-13T20:10:54.755Z" },
  },
};

describe("parseOpencodeUsage", () => {
  it("reads rolling/weekly/monthly percents", () => {
    const w = parseOpencodeUsage(sample);
    assert.deepEqual(
      w.map((x) => [x.name, x.percent]),
      [
        ["rolling", 12.4],
        ["weekly", 40],
        ["monthly", 0],
      ],
    );
  });
  it("rejects junk", () => {
    assert.throws(() => parseOpencodeUsage({}), /bad usage/);
    assert.throws(() => parseOpencodeUsage({ usage: {} }), /no usage windows/);
  });
});

describe("parseXaiBilling", () => {
  it("reads monthly used/limit and reset", () => {
    const w = parseXaiBilling({
      config: {
        monthlyLimit: { val: 40 },
        used: { val: 10 },
        billingPeriodEnd: "2026-09-01T00:00:00+00:00",
      },
    });
    assert.equal(w.length, 1);
    assert.equal(w[0].name, "monthly");
    assert.equal(w[0].percent, 25);
    assert.equal(w[0].resetsAt, "2026-09-01T00:00:00+00:00");
  });
  it("reads weekly creditUsagePercent", () => {
    const w = parseXaiBilling({
      config: {
        creditUsagePercent: 4,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-08-23T15:42:47.763003+00:00",
        },
      },
    });
    assert.equal(w.length, 1);
    assert.equal(w[0].name, "weekly");
    assert.equal(w[0].percent, 4);
    assert.equal(w[0].resetsAt, "2026-08-23T15:42:47.763003+00:00");
  });
  it("unmetered + tier is a plan row, not 0%", () => {
    const w = parseXaiBilling({ config: { monthlyLimit: { val: 0 }, used: { val: 0 } } }, "SuperGrok");
    assert.deepEqual(
      w.map((x) => [x.name, x.text, x.percent]),
      [["plan", "SuperGrok", 0]],
    );
  });
  it("reads on-demand from current history cycle", () => {
    const w = parseXaiBilling({
      config: {
        used: { val: 0 },
        monthlyLimit: { val: 0 },
        onDemandCap: { val: 50 },
        billingPeriodEnd: "2026-09-01T00:00:00+00:00",
        history: [{ billingCycle: { year: 2026, month: 8 }, onDemandUsed: { val: 10 } }],
      },
    });
    assert.equal(w.length, 1);
    assert.equal(w[0].name, "on-demand");
    assert.equal(w[0].percent, 20);
  });
  it("reads prepaid credits", () => {
    const w = parseXaiBilling({ config: { used: { val: 0 }, prepaidBalance: { val: 12 } } });
    assert.equal(w[0].name, "credits");
    assert.equal(w[0].text, "$12");
  });
  it("rejects junk", () => {
    assert.throws(() => parseXaiBilling({}), /bad billing/);
    assert.throws(() => parseXaiBilling({ config: {} }), /no usage windows/);
  });
});

describe("parseXaiTier", () => {
  it("reads subscription_tier_display", () => {
    assert.equal(parseXaiTier({ subscription_tier_display: "SuperGrok" }), "SuperGrok");
    assert.equal(parseXaiTier({}), undefined);
  });
});

describe("parseOpenAICodexUsage", () => {
  const sample = {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 48,
        limit_window_seconds: 18_000,
        reset_at: 1_787_866_019,
      },
      secondary_window: {
        used_percent: 7,
        limit_window_seconds: 604_800,
        reset_at: 1_788_452_819,
      },
    },
  };
  it("reads 5h and weekly percents", () => {
    const w = parseOpenAICodexUsage(sample);
    assert.deepEqual(
      w.map((x) => [x.name, x.text ?? x.percent, x.resetsAt]),
      [
        ["plan", "plus", undefined],
        ["5h", 48, new Date(1_787_866_019 * 1000).toISOString()],
        ["weekly", 7, new Date(1_788_452_819 * 1000).toISOString()],
      ],
    );
  });
  it("names other window lengths by duration", () => {
    const w = parseOpenAICodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 10_800 },
        secondary_window: { used_percent: 20, limit_window_seconds: 172_800 },
      },
    });
    assert.deepEqual(
      w.map((x) => x.name),
      ["3h", "2d"],
    );
  });
  it("rejects junk", () => {
    assert.throws(() => parseOpenAICodexUsage({}), /no usage windows/);
    assert.throws(() => parseOpenAICodexUsage(null), /bad usage/);
  });
});

describe("hottest / remaining / bar", () => {
  it("picks the highest used %", () => {
    const w = parseOpencodeUsage(sample);
    assert.equal(hottest(w).name, "weekly");
    assert.equal(hottest(w).percent, 40);
  });
  it("remaining is 100 minus used", () => {
    assert.equal(remaining(40), 60);
    assert.equal(remaining(0), 100);
    assert.equal(remaining(100), 0);
  });
  it("bar fills by percent", () => {
    assert.equal(bar(0, 10), "░░░░░░░░░░");
    assert.equal(bar(100, 10), "██████████");
    assert.equal(bar(40, 10), "████░░░░░░");
  });
});

describe("until", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  it("formats remaining time", () => {
    assert.equal(until("2026-08-17T12:20:00.000Z", now), "20m");
    assert.equal(until("2026-08-17T15:00:00.000Z", now), "3h");
    assert.equal(until("2026-08-19T12:00:00.000Z", now), "2d");
    assert.equal(until("2026-08-17T11:00:00.000Z", now), "now");
  });
});

describe("formatFooter / formatReport", () => {
  const windows: QuotaWindow[] = parseOpencodeUsage(sample);
  const rows: ProviderRow[] = [
    { id: "opencode-go", short: "go", name: "OpenCode Go", kind: "ok", windows },
    { id: "cursor", short: "cursor", name: "Cursor", kind: "unsupported" },
    { id: "xai", short: "xai", name: "xAI", kind: "error", error: "HTTP 404" },
  ];
  it("footer is provider-hottest window with %", () => {
    assert.equal(formatFooter(rows), "go-weekly 40%");
  });
  it("openai-codex footer shows 5h and weekly", () => {
    const oai: ProviderRow = {
      id: "openai-codex",
      short: "oai",
      name: "OpenAI Codex",
      kind: "ok",
      windows: parseOpenAICodexUsage({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 48, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 7, limit_window_seconds: 604_800 },
        },
      }),
    };
    assert.equal(formatFooter([...rows, oai]), "go-weekly 40% · oai-5h 48% · oai-weekly 7%");
  });
  it("report has used, left, and reset", () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const text = formatReport(rows, now);
    assert.match(text, /OpenCode Go/);
    assert.match(text, /40% used {2}60% left/);
    assert.match(text, /linked — no remaining-quota API/);
    assert.match(text, /error: HTTP 404/);
  });
  it("empty is honest", () => {
    assert.equal(formatFooter([]), "");
    assert.equal(formatReport([]), "No linked subscriptions.");
  });
  it("plan-only xAI is the tier, not 0% used", () => {
    const xai: ProviderRow = {
      id: "xai",
      short: "xai",
      name: "xAI",
      kind: "ok",
      windows: [{ name: "plan", percent: 0, status: "ok", text: "SuperGrok" }],
    };
    assert.equal(formatFooter([xai]), "xai SuperGrok");
    assert.match(formatReport([xai]), /plan\s+SuperGrok/);
    assert.doesNotMatch(formatReport([xai]), /0% used/);
  });
});
