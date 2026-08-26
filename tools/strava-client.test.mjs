// tools/strava-client.test.mjs — unit tests for tools/strava-client.mjs.
// Uses an injected fetchImpl stub throughout, never real network — see
// tools/beta-allowlist-remote.test.mjs for the same pattern.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createStravaClient } from "./strava-client.mjs";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

describe("refreshAccessToken", () => {
  test("returns the access token from a successful refresh", async () => {
    let seenUrl, seenBody;
    const client = createStravaClient({
      fetchImpl: async (url, opts) => {
        seenUrl = url;
        seenBody = JSON.parse(opts.body);
        return jsonResponse({ access_token: "tok-123" });
      },
    });
    const token = await client.refreshAccessToken({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" });
    assert.equal(token, "tok-123");
    assert.equal(seenUrl, "https://www.strava.com/oauth/token");
    assert.deepEqual(seenBody, {
      client_id: "id", client_secret: "secret", refresh_token: "refresh", grant_type: "refresh_token",
    });
  });

  test("throws when the response has no access_token", async () => {
    const client = createStravaClient({
      fetchImpl: async () => jsonResponse({ error: "invalid_grant" }),
    });
    await assert.rejects(
      () => client.refreshAccessToken({ clientId: "id", clientSecret: "s", refreshToken: "r" }),
      /Strava token refresh failed/
    );
  });
});

describe("getTargetActivity", () => {
  test("with no override, fetches the latest activity (per_page=1) and returns the first item", async () => {
    let seenUrl;
    const client = createStravaClient({
      fetchImpl: async (url) => { seenUrl = url; return jsonResponse([{ id: 1, name: "Ride A" }]); },
    });
    const activity = await client.getTargetActivity("tok", "");
    assert.equal(activity.id, 1);
    assert.match(seenUrl, /athlete\/activities\?per_page=1$/);
  });

  test("with an override id, fetches that specific activity directly", async () => {
    let seenUrl;
    const client = createStravaClient({
      fetchImpl: async (url) => { seenUrl = url; return jsonResponse({ id: 999, name: "Specific Ride" }); },
    });
    const activity = await client.getTargetActivity("tok", "999");
    assert.equal(activity.id, 999);
    assert.match(seenUrl, /activities\/999$/);
  });

  test("throws on a non-ok response", async () => {
    const client = createStravaClient({
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }),
    });
    await assert.rejects(() => client.getTargetActivity("tok", ""), /Strava activities fetch failed \(500\)/);
  });
});

describe("getActivityLatLngStream", () => {
  test("returns the latlng data array on success", async () => {
    const client = createStravaClient({
      fetchImpl: async () => jsonResponse({ latlng: { data: [[1, 2], [3, 4]] } }),
    });
    const points = await client.getActivityLatLngStream("tok", 1);
    assert.deepEqual(points, [[1, 2], [3, 4]]);
  });

  test("returns [] on a non-ok response rather than throwing (never blocks the pipeline)", async () => {
    const client = createStravaClient({
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 404 }),
    });
    const points = await client.getActivityLatLngStream("tok", 1);
    assert.deepEqual(points, []);
  });
});

describe("rankSegmentsByPopularity", () => {
  test("dedupes by segment id (last-seen name for that id wins), ranks by athlete_count descending", async () => {
    const counts = { 1: 500, 2: 50, 3: 900 };
    const client = createStravaClient({
      fetchImpl: async (url) => {
        const id = Number(url.match(/segments\/(\d+)/)[1]);
        return jsonResponse({ athlete_count: counts[id] });
      },
    });
    const efforts = [
      { segment: { id: 1 }, segment_name: "Segment One" },
      { segment: { id: 2 }, segment_name: "Segment Two" },
      { segment: { id: 1 }, segment_name: "Segment One (dup)" }, // deduped by id — last name wins
      { segment: { id: 3 }, segment_name: "Segment Three" },
    ];
    const names = await client.rankSegmentsByPopularity("tok", efforts);
    assert.deepEqual(names, ["Segment Three", "Segment One (dup)", "Segment Two"]);
  });

  test("a failed per-segment fetch counts as athleteCount 0 rather than failing the batch", async () => {
    const client = createStravaClient({
      fetchImpl: async (url) => {
        if (url.includes("/segments/1")) throw new Error("network blip");
        return jsonResponse({ athlete_count: 10 });
      },
    });
    const efforts = [
      { segment: { id: 1 }, segment_name: "Flaky" },
      { segment: { id: 2 }, segment_name: "Reliable" },
    ];
    const names = await client.rankSegmentsByPopularity("tok", efforts);
    assert.deepEqual(names, ["Reliable", "Flaky"]);
  });
});

describe("updateActivity", () => {
  test("PUTs description and name (when given) as form-encoded body", async () => {
    let seenUrl, seenOpts;
    const client = createStravaClient({
      fetchImpl: async (url, opts) => { seenUrl = url; seenOpts = opts; return jsonResponse({}); },
    });
    await client.updateActivity("tok", 42, { description: "desc", name: "Title" });
    assert.match(seenUrl, /activities\/42$/);
    assert.equal(seenOpts.method, "PUT");
    assert.equal(seenOpts.body, "description=desc&name=Title");
  });

  test("omits name from the body when not given (manual title-not-generated case)", async () => {
    let seenOpts;
    const client = createStravaClient({
      fetchImpl: async (url, opts) => { seenOpts = opts; return jsonResponse({}); },
    });
    await client.updateActivity("tok", 42, { description: "desc", name: null });
    assert.equal(seenOpts.body, "description=desc");
  });

  test("throws on a non-ok response", async () => {
    const client = createStravaClient({
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 422 }),
    });
    await assert.rejects(
      () => client.updateActivity("tok", 42, { description: "d" }),
      /Strava activity update failed \(422\)/
    );
  });
});
