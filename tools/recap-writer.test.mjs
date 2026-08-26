// tools/recap-writer.test.mjs — unit tests for tools/recap-writer.mjs
// (prompt building + the Claude call). Uses an injected fetchImpl stub
// throughout, never real network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRecapPrompt, generateRecap } from "./recap-writer.mjs";

function baseArgs(overrides = {}) {
  return {
    detail: { name: "Morning Ride", start_date_local: "2026-08-25T07:00:00Z" },
    mi: "20.0",
    timeStr: "1:15",
    ft: "1,200",
    videoTitle: "Morning Ride Video",
    segments: ["Segment A", "Segment B"],
    roadNames: [],
    riderNotes: null,
    ...overrides,
  };
}

describe("buildRecapPrompt", () => {
  test("includes ride data fields", () => {
    const prompt = buildRecapPrompt(baseArgs());
    assert.match(prompt, /Current activity name: Morning Ride/);
    assert.match(prompt, /Distance: 20\.0 mi · Moving time: 1:15 · Elevation gain: 1,200 ft/);
    assert.match(prompt, /Video title: Morning Ride Video/);
    assert.match(prompt, /Popular segments ridden \(most riders first\): Segment A; Segment B/);
  });

  test("omits the roads-ridden line when roadNames is empty", () => {
    const prompt = buildRecapPrompt(baseArgs({ roadNames: [] }));
    assert.doesNotMatch(prompt, /Roads ridden, in the order ridden/);
  });

  test("includes the roads-ridden line, in given order, when roadNames is non-empty", () => {
    const prompt = buildRecapPrompt(baseArgs({ roadNames: ["Road One", "Road Two"] }));
    assert.match(prompt, /Roads ridden, in the order ridden: Road One; Road Two/);
  });

  test("omits rider notes block when riderNotes is null", () => {
    const prompt = buildRecapPrompt(baseArgs({ riderNotes: null }));
    assert.doesNotMatch(prompt, /rider recorded these notes/);
  });

  test("includes rider notes verbatim, quoted, when present", () => {
    const prompt = buildRecapPrompt(baseArgs({ riderNotes: "Great ride, felt strong today" }));
    assert.match(prompt, /rider recorded these notes/);
    assert.match(prompt, /"""Great ride, felt strong today"""/);
  });

  test("segments falls back to n/a when empty", () => {
    const prompt = buildRecapPrompt(baseArgs({ segments: [] }));
    assert.match(prompt, /Popular segments ridden \(most riders first\): n\/a/);
  });
});

function jsonResponse(body, { ok = true } = {}) {
  return { ok, async json() { return body; } };
}

function claudeSuccess(title, opener) {
  return jsonResponse({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ title, opener }) }],
  });
}

describe("generateRecap", () => {
  test("returns ok:true with title/opener on a well-formed success response", async () => {
    const result = await generateRecap({
      prompt: "p", apiKey: "key",
      fetchImpl: async () => claudeSuccess("A Nice Title", "A nice opener."),
    });
    assert.deepEqual(result, { ok: true, title: "A Nice Title", opener: "A nice opener." });
  });

  test("sends the prompt and model in the request body", async () => {
    let seenBody;
    await generateRecap({
      prompt: "the prompt text", apiKey: "key",
      fetchImpl: async (url, opts) => { seenBody = JSON.parse(opts.body); return claudeSuccess("T", "O"); },
    });
    assert.equal(seenBody.messages[0].content, "the prompt text");
    assert.equal(seenBody.model, "claude-opus-4-8");
  });

  test("drops a title over 100 chars and an opener over 400 chars, rather than using them", async () => {
    const longTitle = "x".repeat(101);
    const longOpener = "y".repeat(401);
    const result = await generateRecap({
      prompt: "p", apiKey: "key",
      fetchImpl: async () => claudeSuccess(longTitle, longOpener),
    });
    assert.equal(result.ok, true);
    assert.equal(result.title, undefined);
    assert.equal(result.opener, undefined);
  });

  test("returns ok:false on a refusal stop_reason, without throwing", async () => {
    const result = await generateRecap({
      prompt: "p", apiKey: "key",
      fetchImpl: async () => jsonResponse({ stop_reason: "refusal" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "refusal");
  });

  test("returns ok:false on a non-ok HTTP response", async () => {
    const result = await generateRecap({
      prompt: "p", apiKey: "key",
      fetchImpl: async () => jsonResponse({ error: { message: "rate limited" } }, { ok: false }),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, { message: "rate limited" });
  });

  test("throws on an unparseable content body (caller is responsible for the try/catch fallback)", async () => {
    await assert.rejects(() => generateRecap({
      prompt: "p", apiKey: "key",
      fetchImpl: async () => jsonResponse({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "not json" }],
      }),
    }));
  });
});
