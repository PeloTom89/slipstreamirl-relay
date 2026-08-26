// tools/per-user-recap.test.mjs — unit tests for tools/per-user-recap.mjs
// against injected stubs (a fake userStore + a fake Strava client, plus a
// stubbed Anthropic endpoint via fetchImpl on the client that
// tools/recap-writer.mjs calls into) — no live network anywhere, same
// pattern as tools/strava-client.test.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runRecapForUser, runPerUserRecaps, RECAP_MARKER } from "./per-user-recap.mjs";

function baseActivity(overrides = {}) {
  return {
    id: 111,
    name: "Evening Ride",
    description: "",
    distance: 16093.4, // 10 mi
    moving_time: 1800, // 30 min
    total_elevation_gain: 100,
    segment_efforts: [],
    ...overrides,
  };
}

function makeStravaClient({ activity = baseActivity(), refreshFails = false, updateActivity } = {}) {
  const calls = { updateActivity: [] };
  return {
    calls,
    async refreshAccessToken() {
      if (refreshFails) throw new Error("invalid_grant");
      return "access-token";
    },
    async getTargetActivity() {
      return activity;
    },
    async getActivityDetail() {
      return activity;
    },
    async getActivityLatLngStream() {
      return [];
    },
    async rankSegmentsByPopularity() {
      return [];
    },
    async updateActivity(accessToken, activityId, body) {
      calls.updateActivity.push({ accessToken, activityId, body });
      if (updateActivity) return updateActivity(accessToken, activityId, body);
    },
  };
}

function makeUserStore({ refreshToken = "raw-refresh", anthropicKey = null, rideSummary = null } = {}) {
  const deleted = [];
  const clearedRideSummaries = [];
  return {
    deleted,
    clearedRideSummaries,
    async getStravaRefreshToken() {
      return refreshToken;
    },
    async getAnthropicKey() {
      return anthropicKey;
    },
    async getRideSummary() {
      return rideSummary;
    },
    async clearRideSummary(twitchId) {
      clearedRideSummaries.push(twitchId);
    },
    async deleteStravaLink(twitchId) {
      deleted.push(twitchId);
    },
  };
}

describe("runRecapForUser", () => {
  test("no refresh token on record — skips without calling Strava", async () => {
    const userStore = makeUserStore({ refreshToken: null });
    const stravaClient = makeStravaClient();
    const result = await runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} });
    assert.equal(result.skipped, "no strava refresh token on record");
    assert.equal(stravaClient.calls.updateActivity.length, 0);
  });

  test("no activity found — skips", async () => {
    const userStore = makeUserStore();
    const stravaClient = makeStravaClient({ activity: null });
    const result = await runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} });
    assert.equal(result.skipped, "no strava activity found");
  });

  test("activity already carries the recap marker — skips without rewriting", async () => {
    const userStore = makeUserStore();
    const stravaClient = makeStravaClient({
      activity: baseActivity({ description: `Some notes\n\n${RECAP_MARKER}` }),
    });
    const result = await runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} });
    assert.equal(result.skipped, "activity already has a per-user recap");
    assert.equal(stravaClient.calls.updateActivity.length, 0);
  });

  test("no anthropic key at all (no per-user key, no fallback) — still writes a stats-only recap", async () => {
    const userStore = makeUserStore({ anthropicKey: null });
    const stravaClient = makeStravaClient();
    const result = await runRecapForUser({
      twitchId: "t1", userStore, stravaClient, fallbackAnthropicKey: null, log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(stravaClient.calls.updateActivity.length, 1);
    const { body } = stravaClient.calls.updateActivity[0];
    assert.ok(body.description.includes(RECAP_MARKER));
    assert.ok(body.description.includes("mi"));
    assert.equal(body.name, null); // no title generated without a Claude call
  });

  test("key selection: falls back to the operator's key when the user has none of their own", async () => {
    const userStore = makeUserStore({ anthropicKey: null });
    let seenApiKey;
    const stravaClient = makeStravaClient();
    // generateRecap calls fetch internally with apiBase defaulting to the real
    // Anthropic host — inject a fake global fetch via monkeypatching is overkill
    // here; instead verify fallback selection directly through the key that
    // would be passed, by checking the Claude call never happens without a key
    // above, and DOES happen (attempted) here by observing no throw and a
    // written recap. The exact key value reaching generateRecap is covered by
    // the "uses the user's own key over the fallback" test below via a stub
    // fetchImpl swapped onto globalThis.fetch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      seenApiKey = opts.headers["x-api-key"];
      return {
        ok: true,
        async json() {
          return { content: [{ type: "text", text: JSON.stringify({ title: "T", opener: "O" }) }] };
        },
      };
    };
    try {
      await runRecapForUser({
        twitchId: "t1", userStore, stravaClient, fallbackAnthropicKey: "operator-key", log: () => {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(seenApiKey, "operator-key");
  });

  test("key selection: uses the user's own key over the fallback when both are present", async () => {
    const userStore = makeUserStore({ anthropicKey: "user-own-key" });
    const stravaClient = makeStravaClient();
    let seenApiKey;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      seenApiKey = opts.headers["x-api-key"];
      return {
        ok: true,
        async json() {
          return { content: [{ type: "text", text: JSON.stringify({ title: "T", opener: "O" }) }] };
        },
      };
    };
    try {
      await runRecapForUser({
        twitchId: "t1", userStore, stravaClient, fallbackAnthropicKey: "operator-key", log: () => {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(seenApiKey, "user-own-key");
  });

  test("folds the rider's own dictated ride summary into the recap prompt as riderNotes", async () => {
    const userStore = makeUserStore({ rideSummary: { summary: "Felt great, chased a sunset.", recordedAt: "2026-01-01T00:00:00Z" } });
    const stravaClient = makeStravaClient();
    let seenBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      seenBody = JSON.parse(opts.body);
      return {
        ok: true,
        async json() {
          return { content: [{ type: "text", text: JSON.stringify({ title: "T", opener: "O" }) }] };
        },
      };
    };
    try {
      await runRecapForUser({
        twitchId: "t1", userStore, stravaClient, fallbackAnthropicKey: "operator-key", log: () => {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const promptText = seenBody.messages[0].content;
    assert.match(promptText, /Felt great, chased a sunset\./);
  });

  test("clears the ride summary after a successful write that used it", async () => {
    const userStore = makeUserStore({
      anthropicKey: "user-own-key",
      rideSummary: { summary: "Rode out to the lake.", recordedAt: "2026-01-01T00:00:00Z" },
    });
    const stravaClient = makeStravaClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { content: [{ type: "text", text: JSON.stringify({ title: "T", opener: "O" }) }] };
      },
    });
    try {
      await runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(userStore.clearedRideSummaries, ["t1"]);
  });

  test("does not touch clearRideSummary when there was no ride summary to clear", async () => {
    const userStore = makeUserStore({ rideSummary: null });
    const stravaClient = makeStravaClient();
    await runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} });
    assert.deepEqual(userStore.clearedRideSummaries, []);
  });

  test("dryRun never clears the ride summary", async () => {
    const userStore = makeUserStore({
      rideSummary: { summary: "Rode out to the lake.", recordedAt: "2026-01-01T00:00:00Z" },
    });
    const stravaClient = makeStravaClient();
    await runRecapForUser({ twitchId: "t1", userStore, stravaClient, dryRun: true, log: () => {} });
    assert.deepEqual(userStore.clearedRideSummaries, []);
  });

  test("dryRun never calls updateActivity", async () => {
    const userStore = makeUserStore();
    const stravaClient = makeStravaClient();
    const result = await runRecapForUser({
      twitchId: "t1", userStore, stravaClient, dryRun: true, log: () => {},
    });
    assert.equal(result.dryRun, true);
    assert.equal(stravaClient.calls.updateActivity.length, 0);
  });

  test("a revoked/failing refresh throws a STRAVA_AUTH_FAILURE-coded error", async () => {
    const userStore = makeUserStore();
    const stravaClient = makeStravaClient({ refreshFails: true });
    await assert.rejects(
      () => runRecapForUser({ twitchId: "t1", userStore, stravaClient, log: () => {} }),
      (err) => err.code === "STRAVA_AUTH_FAILURE"
    );
  });
});

describe("runPerUserRecaps", () => {
  function makeStore(records) {
    const deleted = [];
    return {
      deleted,
      async listLinkedUsers() {
        return records;
      },
      async getStravaRefreshToken(twitchId) {
        const r = records.find((u) => u.twitchId === twitchId);
        return r ? r.strava.refreshTokenRaw : null;
      },
      async getAnthropicKey() {
        return null;
      },
      async getRideSummary() {
        return null;
      },
      async clearRideSummary() {},
      async deleteStravaLink(twitchId) {
        deleted.push(twitchId);
      },
    };
  }

  test("one user's failure does not abort the loop for other users", async () => {
    const records = [
      { twitchId: "good-1", strava: { athleteId: 1, refreshTokenRaw: "r1" } },
      { twitchId: "bad", strava: { athleteId: 2, refreshTokenRaw: "r2" } },
      { twitchId: "good-2", strava: { athleteId: 3, refreshTokenRaw: "r3" } },
    ];
    const userStore = makeStore(records);
    let call = 0;
    const summary = await runPerUserRecaps({
      userStore,
      clientId: "cid",
      clientSecret: "csecret",
      log: () => {},
      stravaClientFactory: () => {
        call += 1;
        const isBad = call === 2; // second user processed throws mid-pipeline
        return makeStravaClient({
          activity: baseActivity({ id: call }),
          updateActivity: isBad ? () => { throw new Error("strava 500"); } : undefined,
        });
      },
    });
    assert.equal(summary.processed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.unlinked, 0);
    assert.deepEqual(userStore.deleted, []);
  });

  test("a revoked token unlinks that user and continues to the next", async () => {
    const records = [
      { twitchId: "revoked", strava: { athleteId: 1, refreshTokenRaw: "r1" } },
      { twitchId: "fine", strava: { athleteId: 2, refreshTokenRaw: "r2" } },
    ];
    const userStore = makeStore(records);
    let call = 0;
    const summary = await runPerUserRecaps({
      userStore,
      clientId: "cid",
      clientSecret: "csecret",
      log: () => {},
      stravaClientFactory: () => {
        call += 1;
        return makeStravaClient({ refreshFails: call === 1 });
      },
    });
    assert.equal(summary.unlinked, 1);
    assert.equal(summary.processed, 1);
    assert.deepEqual(userStore.deleted, ["revoked"]);
  });

  test("dedupes by athlete id against the operator's own account", async () => {
    const records = [
      { twitchId: "operator-also-linked", strava: { athleteId: 42, refreshTokenRaw: "r1" } },
      { twitchId: "other-user", strava: { athleteId: 99, refreshTokenRaw: "r2" } },
    ];
    const userStore = makeStore(records);
    const summary = await runPerUserRecaps({
      userStore,
      clientId: "cid",
      clientSecret: "csecret",
      excludeAthleteId: 42,
      log: () => {},
      stravaClientFactory: () => makeStravaClient(),
    });
    assert.equal(summary.processed, 1);
    assert.equal(summary.skipped, 1);
  });

  test("enumeration failure itself is non-fatal — returns a zeroed summary", async () => {
    const userStore = {
      async listLinkedUsers() {
        throw new Error("upstash down");
      },
    };
    const summary = await runPerUserRecaps({ userStore, clientId: "cid", clientSecret: "csecret", log: () => {} });
    assert.deepEqual(summary, { processed: 0, skipped: 0, unlinked: 0, failed: 0 });
  });
});
