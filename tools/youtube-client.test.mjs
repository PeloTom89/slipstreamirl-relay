// tools/youtube-client.test.mjs — unit tests for tools/youtube-client.mjs.
// Uses an injected fetchImpl stub throughout, never real network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createYoutubeClient } from "./youtube-client.mjs";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

describe("findRecentVideo", () => {
  test("returns the video's id/publishedAt/decoded title on a match", async () => {
    let seenUrl;
    const client = createYoutubeClient({
      fetchImpl: async (url) => {
        seenUrl = url;
        return jsonResponse({
          items: [{ id: { videoId: "abc123" }, snippet: { publishedAt: "2026-08-25T00:00:00Z", title: "Ride &amp; Chill" } }],
        });
      },
    });
    const video = await client.findRecentVideo({ apiKey: "key", channelId: "chan", sinceIso: "2026-08-24T00:00:00Z" });
    assert.deepEqual(video, { videoId: "abc123", publishedAt: "2026-08-25T00:00:00Z", title: "Ride & Chill" });
    assert.match(seenUrl, /channelId=chan/);
    assert.match(seenUrl, /publishedAfter=2026-08-24T00%3A00%3A00Z/);
  });

  test("returns null when no video is found", async () => {
    const client = createYoutubeClient({ fetchImpl: async () => jsonResponse({ items: [] }) });
    const video = await client.findRecentVideo({ apiKey: "k", channelId: "c", sinceIso: "s" });
    assert.equal(video, null);
  });

  test("throws on a YouTube API error payload", async () => {
    const client = createYoutubeClient({ fetchImpl: async () => jsonResponse({ error: { message: "quota exceeded" } }) });
    await assert.rejects(
      () => client.findRecentVideo({ apiKey: "k", channelId: "c", sinceIso: "s" }),
      /YouTube API error/
    );
  });
});

describe("refreshOAuthToken", () => {
  test("returns the access token from a successful refresh", async () => {
    let seenOpts;
    const client = createYoutubeClient({
      fetchImpl: async (url, opts) => { seenOpts = opts; return jsonResponse({ access_token: "yt-tok" }); },
    });
    const token = await client.refreshOAuthToken({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
    assert.equal(token, "yt-tok");
    assert.equal(seenOpts.headers["Content-Type"], "application/x-www-form-urlencoded");
  });

  test("throws when no access_token comes back", async () => {
    const client = createYoutubeClient({ fetchImpl: async () => jsonResponse({ error: "invalid_grant" }) });
    await assert.rejects(
      () => client.refreshOAuthToken({ clientId: "id", clientSecret: "s", refreshToken: "r" }),
      /YouTube OAuth refresh failed/
    );
  });
});

describe("getVideoSnippet", () => {
  test("returns the snippet of the first item", async () => {
    const client = createYoutubeClient({
      fetchImpl: async () => jsonResponse({ items: [{ snippet: { title: "T", description: "D" } }] }),
    });
    const snippet = await client.getVideoSnippet("tok", "vid1");
    assert.deepEqual(snippet, { title: "T", description: "D" });
  });

  test("throws when no snippet is found", async () => {
    const client = createYoutubeClient({ fetchImpl: async () => jsonResponse({ items: [] }) });
    await assert.rejects(() => client.getVideoSnippet("tok", "vid1"), /Could not fetch current YouTube video snippet/);
  });
});

describe("updateVideoDescription", () => {
  test("PUTs the full existing snippet merged with the new description", async () => {
    let seenBody;
    const client = createYoutubeClient({
      fetchImpl: async (url, opts) => { seenBody = JSON.parse(opts.body); return jsonResponse({}); },
    });
    await client.updateVideoDescription("tok", "vid1", { title: "T", categoryId: "17" }, "new description");
    assert.deepEqual(seenBody, {
      id: "vid1",
      snippet: { title: "T", categoryId: "17", description: "new description" },
    });
  });

  test("throws on a non-ok response", async () => {
    const client = createYoutubeClient({ fetchImpl: async () => jsonResponse({}, { ok: false, status: 403 }) });
    await assert.rejects(
      () => client.updateVideoDescription("tok", "vid1", {}, "d"),
      /YouTube videos\.update failed \(403\)/
    );
  });
});
