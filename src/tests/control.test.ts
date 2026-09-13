import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSenderInfo,
  isSafeAlias,
  isSafeSessionId,
  normalizeMode,
  normalizeWaitUntil,
  parseCommand,
  parseSenderInfo,
  stripSenderInfo,
  wrapSenderInfo,
} from "../control.ts";

describe("isSafeSessionId", () => {
  it("accepts a uuid", () => {
    assert.equal(isSafeSessionId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), true);
  });
  it("rejects empty, path, and traversal ids", () => {
    assert.equal(isSafeSessionId(""), false);
    assert.equal(isSafeSessionId("../secret"), false);
    assert.equal(isSafeSessionId("foo/bar"), false);
    assert.equal(isSafeSessionId("foo\\bar"), false);
  });
});

describe("isSafeAlias", () => {
  it("accepts a session name", () => {
    assert.equal(isSafeAlias("fix-login-page"), true);
  });
  it("rejects empty, path, and traversal aliases", () => {
    assert.equal(isSafeAlias(""), false);
    assert.equal(isSafeAlias("foo/bar"), false);
    assert.equal(isSafeAlias(".."), false);
  });
});

describe("sender info", () => {
  it("wraps json that parseSenderInfo can read back", () => {
    const wrapped = wrapSenderInfo("abc-123", "fix-login");
    assert.match(wrapped, /<sender_info>/);
    assert.deepEqual(parseSenderInfo(`hello${wrapped}`), {
      sessionId: "abc-123",
      sessionName: "fix-login",
    });
  });
  it("omits wrapping when session id is missing", () => {
    assert.equal(wrapSenderInfo(undefined, "name"), "");
    assert.equal(wrapSenderInfo(""), "");
  });
  it("strips sender_info from message text", () => {
    const text = `Please reply.${wrapSenderInfo("abc-123", "fix-login")}`;
    assert.equal(stripSenderInfo(text), "Please reply.");
  });
  it("parses legacy 'session <id>' sender info", () => {
    assert.deepEqual(
      parseSenderInfo("hi <sender_info>session abcdef</sender_info>"),
      { sessionId: "abcdef" },
    );
  });
  it("returns null when no sender_info is present", () => {
    assert.equal(parseSenderInfo("plain message"), null);
  });
  it("formats name and id together", () => {
    assert.equal(formatSenderInfo({ sessionName: "fix-login", sessionId: "abc" }), "fix-login (abc)");
    assert.equal(formatSenderInfo({ sessionName: "fix-login" }), "fix-login");
    assert.equal(formatSenderInfo({ sessionId: "abc" }), "abc");
    assert.equal(formatSenderInfo(null), null);
  });
});

describe("normalizeMode", () => {
  it("accepts steer and follow_up spellings", () => {
    assert.equal(normalizeMode("steer"), "steer");
    assert.equal(normalizeMode("FOLLOW_UP"), "follow_up");
    assert.equal(normalizeMode("follow-up"), "follow_up");
    assert.equal(normalizeMode("followup"), "follow_up");
  });
  it("rejects unknown modes", () => {
    assert.equal(normalizeMode("nextTurn"), null);
  });
});

describe("normalizeWaitUntil", () => {
  it("accepts turn_end and message_processed spellings", () => {
    assert.equal(normalizeWaitUntil("turn_end"), "turn_end");
    assert.equal(normalizeWaitUntil("turn-end"), "turn_end");
    assert.equal(normalizeWaitUntil("message_processed"), "message_processed");
    assert.equal(normalizeWaitUntil("message-processed"), "message_processed");
  });
  it("rejects unknown wait modes", () => {
    assert.equal(normalizeWaitUntil("idle"), null);
  });
});

describe("parseCommand", () => {
  it("parses a send command", () => {
    const parsed = parseCommand(JSON.stringify({ type: "send", message: "hello", mode: "steer" }));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.command?.type, "send");
  });
  it("rejects missing type and invalid json", () => {
    assert.equal(parseCommand("{}").error, "Missing command type");
    assert.ok(parseCommand("not-json").error);
    assert.equal(parseCommand("null").error, "Invalid command");
  });
});
