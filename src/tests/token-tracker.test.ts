import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateOpencodeSessions,
  aggregatePiFileText,
  daysCutoff,
  fmtCost,
  fmtInt,
  formatTable,
  listJsonlFiles,
  parseArgs,
  resolveOpencodeDataDir,
  resolvePiAgentDir,
  type SqlDb,
} from "../token-tracker.ts";

// parseArgs: /tokens [--days N] [--source pi|opencode|all]. Unknown args and
// bad values throw with the usage line so the command can surface it.
describe("parseArgs", () => {
  it("parses days and source", () => {
    assert.deepEqual(parseArgs("--days 7 --source opencode"), { days: 7, source: "opencode" });
  });
  it("defaults to all time and all sources", () => {
    assert.deepEqual(parseArgs(""), {});
    assert.deepEqual(parseArgs("  "), {});
  });
  it("treats --days 0 as all time", () => {
    assert.deepEqual(parseArgs("--days 0"), {});
  });
  it("rejects negative days", () => {
    assert.throws(() => parseArgs("--days -3"), /non-negative/);
  });
  it("rejects unknown sources", () => {
    assert.throws(() => parseArgs("--source tmux"), /must be pi, opencode, or all/);
  });
  it("rejects unknown flags", () => {
    assert.throws(() => parseArgs("--foo"), /Unknown argument/);
  });
});

describe("daysCutoff", () => {
  it("is now minus N days for a positive window", () => {
    const now = 1_800_000_000_000;
    assert.equal(daysCutoff(7, now), now - 7 * 86_400_000);
  });
  it("is undefined for no window or zero days", () => {
    assert.equal(daysCutoff(undefined, 1), undefined);
    assert.equal(daysCutoff(0, 1), undefined);
  });
});

describe("resolveOpencodeDataDir", () => {
  it("honors OPENCODE_DATA_DIR", () => {
    assert.equal(resolveOpencodeDataDir({ OPENCODE_DATA_DIR: "/x" }), "/x");
  });
  it("honors XDG_DATA_HOME", () => {
    assert.equal(resolveOpencodeDataDir({ XDG_DATA_HOME: "/xdg" }), "/xdg/opencode");
  });
  it("falls back to ~/.local/share/opencode", () => {
    assert.ok(resolveOpencodeDataDir({}).endsWith("/.local/share/opencode"));
  });
});

describe("resolvePiAgentDir", () => {
  it("honors PI_AGENT_DIR", () => {
    assert.equal(resolvePiAgentDir({ PI_AGENT_DIR: "/p" }), "/p");
  });
  it("falls back to ~/.pi/agent", () => {
    assert.ok(resolvePiAgentDir({}).endsWith("/.pi/agent"));
  });
});

describe("listJsonlFiles", () => {
  it("returns only jsonl files, recursively, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-essentials-token-test-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "b.jsonl"), "{}");
    writeFileSync(join(dir, "a.jsonl"), "{}");
    writeFileSync(join(dir, "notes.txt"), "{}");
    writeFileSync(join(dir, "sub", "c.jsonl"), "{}");
    const files = listJsonlFiles(dir);
    assert.deepEqual(files.map((f) => f.replace(dir, "")), ["/a.jsonl", "/b.jsonl", "/sub/c.jsonl"], "jsonl only, sorted, recursive");
  });
  it("returns [] for a missing directory", () => {
    assert.deepEqual(listJsonlFiles("definitely-not-a-real-dir-xyz"), []);
  });
});

// aggregatePiFileText: the core pi-side parser. Assistant messages carry
// provider/model/usage; compaction entries carry a retainedTail of assistant
// messages (also billed). Session header timestamps drive the window skip.
// The live session file is appended to while we read, so malformed/partial
// lines must be ignored, not throw.
describe("aggregatePiFileText", () => {
  const assistant = (provider: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "assistant", provider, model, usage },
    });

  it("aggregates usage per provider/model across messages", () => {
    const text = [
      JSON.stringify({ type: "session", timestamp: "2026-08-01T00:00:00.000Z" }),
      assistant("opencode-go", "deepseek-v4-flash", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, reasoning: 20, cost: { total: 0.01 } }),
      assistant("opencode-go", "deepseek-v4-flash", { input: 200, output: 0, cost: { total: 0.005 } }),
      assistant("anthropic", "claude-sonnet-4-6", { input: 1000, output: 100, cost: { total: 0.5 } }),
    ].join("\n");
    const { skipped, totals } = aggregatePiFileText(text, undefined);
    assert.equal(skipped, false);
    assert.equal(totals.size, 2);
    const flash = totals.get("opencode-go/deepseek-v4-flash")!;
    assert.deepEqual(
      { msgs: flash.msgs, input: flash.input, output: flash.output, cacheRead: flash.cacheRead, cacheWrite: flash.cacheWrite, reasoning: flash.reasoning, cost: flash.cost },
      { msgs: 2, input: 300, output: 50, cacheRead: 10, cacheWrite: 5, reasoning: 20, cost: 0.015 },
    );
    const claude = totals.get("anthropic/claude-sonnet-4-6")!;
    assert.deepEqual(claude.cost, 0.5);
  });

  it("counts usage inside compaction retainedTail", () => {
    const text = [
      JSON.stringify({ type: "session", timestamp: "2026-08-01T00:00:00.000Z" }),
      JSON.stringify({
        type: "compaction",
        summary: "…",
        tokensBefore: 50000,
        retainedTail: [
          { role: "assistant", provider: "opencode-go", model: "deepseek-v4-flash", usage: { input: 10, output: 20, cost: { total: 0.001 } } },
        ],
      }),
    ].join("\n");
    const { totals } = aggregatePiFileText(text, undefined);
    assert.equal(totals.get("opencode-go/deepseek-v4-flash")?.msgs, 1);
    assert.equal(totals.get("opencode-go/deepseek-v4-flash")?.input, 10);
  });

  it("skips user/toolResult messages and missing usage", () => {
    const text = [
      JSON.stringify({ type: "session", timestamp: "2026-08-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "m" } }), // no usage
      JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", usage: { input: 99, cost: { total: 9 } } } }),
    ].join("\n");
    const { totals } = aggregatePiFileText(text, undefined);
    assert.equal(totals.size, 0);
  });

  it("skips whole files whose session header predates the cutoff", () => {
    const old = JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" + assistant("p", "m", { input: 1, cost: { total: 1 } });
    const { skipped, totals } = aggregatePiFileText(old, Date.parse("2026-06-01T00:00:00.000Z"));
    assert.equal(skipped, true);
    assert.equal(totals.size, 0);
  });

  it("ignores malformed/partial lines (live file being appended to)", () => {
    const text = [
      JSON.stringify({ type: "session", timestamp: "2026-08-01T00:00:00.000Z" }),
      assistant("p", "m", { input: 1, cost: { total: 0.001 } }),
      '{"type":"message","message":{...partial...',
    ].join("\n");
    const { totals } = aggregatePiFileText(text, undefined);
    assert.equal(totals.get("p/m")?.msgs, 1);
  });

  it("includes files without a parseable header timestamp", () => {
    const text = assistant("p", "m", { input: 1, cost: { total: 0.001 } });
    const { skipped, totals } = aggregatePiFileText(text, Date.now());
    assert.equal(skipped, false);
    assert.equal(totals.get("p/m")?.msgs, 1);
  });
});

// aggregateOpencodeSessions: the SQL against opencode's ledger. Nulls in the
// aggregate columns and NULL model rows must not poison the sums.
describe("aggregateOpencodeSessions", () => {
  function makeDb(rows: Record<string, unknown>[]): SqlDb {
    const db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE session (
        model TEXT, time_created INTEGER,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost REAL
      )`,
    );
    const stmt = db.prepare(
      `INSERT INTO session (model, time_created, tokens_input, tokens_output, tokens_reasoning,
         tokens_cache_read, tokens_cache_write, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) stmt.run(r.model, r.time_created, r.tokens_input, r.tokens_output, r.tokens_reasoning, r.tokens_cache_read, r.tokens_cache_write, r.cost);
    return db as unknown as SqlDb;
  }

  it("groups by model with sessions count and token/cost sums", () => {
    const db = makeDb([
      { model: "opencode-go/deepseek-v4-pro", time_created: 1, tokens_input: 1000, tokens_output: 100, tokens_cache_read: 5000, tokens_cache_write: 50, tokens_reasoning: 30, cost: 0.5 },
      { model: "opencode-go/deepseek-v4-pro", time_created: 2, tokens_input: 500, tokens_output: 50, tokens_cache_read: 0, tokens_cache_write: 0, tokens_reasoning: 0, cost: 0.25 },
      { model: "opencode-go/deepseek-v4-flash", time_created: 3, tokens_input: 100, tokens_output: 10, tokens_cache_read: 0, tokens_cache_write: 0, tokens_reasoning: 0, cost: 0.01 },
    ]);
    const rows = aggregateOpencodeSessions(db, undefined);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, "opencode-go/deepseek-v4-pro"); // cost desc
    assert.deepEqual(
      { sessions: rows[0].sessions, input: rows[0].input, output: rows[0].output, cacheRead: rows[0].cacheRead, cacheWrite: rows[0].cacheWrite, reasoning: rows[0].reasoning, cost: rows[0].cost },
      { sessions: 2, input: 1500, output: 150, cacheRead: 5000, cacheWrite: 50, reasoning: 30, cost: 0.75 },
    );
  });

  it("coalesces NULL token/cost columns and ignores NULL-model rows", () => {
    const db = makeDb([
      { model: "opencode-go/deepseek-v4-flash", time_created: 1, tokens_input: null, tokens_output: null, tokens_cache_read: null, tokens_cache_write: null, tokens_reasoning: null, cost: null },
      { model: null, time_created: 1, tokens_input: 999, tokens_output: 999, tokens_cache_read: 999, tokens_cache_write: 999, tokens_reasoning: 999, cost: 999 },
    ]);
    const rows = aggregateOpencodeSessions(db, undefined);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { sessions: rows[0].sessions, input: rows[0].input, cost: rows[0].cost },
      { sessions: 1, input: 0, cost: 0 },
    );
  });

  it("parses JSON model names and merges variants of the same model", () => {
    const db = makeDb([
      { model: JSON.stringify({ id: "deepseek-v4-pro", providerID: "opencode-go", variant: "default" }), time_created: 1, tokens_input: 100, tokens_output: 10, tokens_cache_read: 0, tokens_cache_write: 0, tokens_reasoning: 0, cost: 0.1 },
      { model: JSON.stringify({ id: "deepseek-v4-pro", providerID: "opencode-go", variant: "high" }), time_created: 2, tokens_input: 200, tokens_output: 20, tokens_cache_read: 0, tokens_cache_write: 0, tokens_reasoning: 0, cost: 0.2 },
      { model: "plain/model-name", time_created: 3, tokens_input: 50, tokens_output: 5, tokens_cache_read: 0, tokens_cache_write: 0, tokens_reasoning: 0, cost: 0.05 },
    ]);
    const rows = aggregateOpencodeSessions(db, undefined);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, "opencode-go/deepseek-v4-pro"); // variants merged
    assert.equal(rows[0].sessions, 2);
    assert.ok(Math.abs(rows[0].cost - 0.3) < 1e-9, "costs merge (float-safe compare)");
    assert.equal(rows[1].model, "plain/model-name");
  });

  it("honors the time window via time_created", () => {
    const db = makeDb([
      { model: "a", time_created: 1000, tokens_input: 1, tokens_output: 1, tokens_cache_read: 1, tokens_cache_write: 1, tokens_reasoning: 1, cost: 0.01 },
      { model: "a", time_created: 999, tokens_input: 100, tokens_output: 100, tokens_cache_read: 100, tokens_cache_write: 100, tokens_reasoning: 100, cost: 1 },
    ]);
    const rows = aggregateOpencodeSessions(db, 1000);
    assert.equal(rows[0].sessions, 1);
    assert.equal(rows[0].input, 1);
  });
});

describe("fmtInt / fmtCost", () => {
  it("formats integers with thousands separators", () => {
    assert.equal(fmtInt(1234567), "1,234,567");
    assert.equal(fmtInt(0), "0");
  });
  it("formats costs: cents above a cent, 4 decimals below", () => {
    assert.equal(fmtCost(1.234), "$1.23");
    assert.equal(fmtCost(0.0001781584), "$0.0002");
    assert.equal(fmtCost(0), "$0.00");
  });
});

describe("formatTable", () => {
  it("aligns: model left, numbers right", () => {
    const t = formatTable(
      ["model", "msgs", "cost"],
      [["a/long-model-name", "10", "$1.00"], ["b", "12345", "$0.01"]],
      [false, true, true],
    );
    const lines = t.split("\n");
    assert.equal(lines[0], "model               msgs   cost");
    assert.equal(lines[1], "a/long-model-name     10  $1.00");
    assert.equal(lines[2], "b                  12345  $0.01");
  });
});
