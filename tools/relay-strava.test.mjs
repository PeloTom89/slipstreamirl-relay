// tools/relay-strava.test.mjs — integration tests for the Strava account
// linking endpoints (GET /strava-authorize, GET /strava-callback, POST
// /strava-deauthorize) against a real spawned server.js, with local HTTP
// stubs standing in for Twitch Helix, Strava's /oauth endpoints, and
// Upstash's REST API (TWITCH_HELIX_BASE / STRAVA_OAUTH_BASE / UPSTASH_API_BASE
// overrides — test-only, see server.js/AGENTS.md). No live Twitch, Strava, or
// Upstash credentials used anywhere here.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { startServer } from "./spawn-relay.mjs";
import { signStravaState } from "./strava-state-token.js";
import { signChannelToken } from "./channel-token.js";

function startStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
  });
}

const TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

describe("Strava account linking (MULTI_TENANT + user store + Strava configured)", () => {
  const JWT_SECRET = "test-jwt-secret";
  const STRAVA_CLIENT_ID = "strava-cid";
  const STRAVA_CLIENT_SECRET = "strava-csecret";

  let twitchStub, stravaStub, upstashStub, server;
  let twitchIdToReturn = "twitch-1";
  let tokenRequests, deauthRequests;
  let tokenStatus, tokenResponse, deauthStatus;
  let upstashStore;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const authHeader = req.headers["authorization"] || "";
      if (authHeader === "Bearer invalid-token") { res.end(JSON.stringify({ data: [] })); return; }
      res.end(JSON.stringify({ data: [{ id: twitchIdToReturn }] }));
    });

    stravaStub = await startStub(async (req, res) => {
      const body = await readBody(req);
      if (req.url === "/token") {
        tokenRequests.push(new URLSearchParams(body));
        res.writeHead(tokenStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenResponse));
        return;
      }
      if (req.url === "/deauthorize") {
        deauthRequests.push(new URLSearchParams(body));
        res.writeHead(deauthStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404); res.end("not found in strava stub");
    });

    upstashStub = await startStub((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const getMatch = req.method === "GET" && req.url.match(/^\/get\/(.+)$/);
        const setMatch = req.method === "POST" && req.url.match(/^\/set\/(.+)$/);
        if (getMatch) {
          const key = decodeURIComponent(getMatch[1]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: upstashStore.has(key) ? upstashStore.get(key) : null }));
          return;
        }
        if (setMatch) {
          const key = decodeURIComponent(setMatch[1]);
          upstashStore.set(key, body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "OK" }));
          return;
        }
        res.writeHead(404); res.end("not found in upstash stub");
      });
    });

    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRAVA_CLIENT_ID,
      STRAVA_CLIENT_SECRET,
      STRAVA_OAUTH_BASE: `http://127.0.0.1:${stravaStub.address().port}`,
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      TOKEN_ENCRYPTION_KEY,
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashStub.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: "test-upstash-token",
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stravaStub.close(r));
    await new Promise((r) => upstashStub.close(r));
  });

  beforeEach(() => {
    tokenRequests = [];
    deauthRequests = [];
    tokenStatus = 200;
    deauthStatus = 200;
    tokenResponse = { access_token: "access-abc", refresh_token: "refresh-abc", expires_at: 1_700_000_000, athlete: { id: 555 } };
    upstashStore = new Map();
  });

  async function authorize(twitchAccessToken = "fake-access-token") {
    const url = twitchAccessToken === null
      ? `${server.baseHttp}/strava-authorize`
      : `${server.baseHttp}/strava-authorize?twitchAccessToken=${encodeURIComponent(twitchAccessToken)}`;
    return fetch(url, { redirect: "manual" });
  }

  async function callback(query) {
    return fetch(`${server.baseHttp}/strava-callback?${query}`, { redirect: "manual" });
  }

  async function deauthorizeCall(twitchAccessToken = "fake-access-token") {
    return fetch(`${server.baseHttp}/strava-deauthorize`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken }),
    });
  }

  test("GET /strava-authorize requires twitchAccessToken", async () => {
    const res = await authorize(null);
    assert.equal(res.status, 400);
  });

  test("GET /strava-authorize rejects an unverifiable Twitch token", async () => {
    const res = await authorize("invalid-token");
    assert.equal(res.status, 401);
  });

  test("GET /strava-authorize redirects to Strava with client_id, redirect_uri, response_type=code, scope, and a signed state", async () => {
    twitchIdToReturn = "twitch-authorize-1";
    const res = await authorize();
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location"));
    assert.equal(location.origin + location.pathname, `http://127.0.0.1:${stravaStub.address().port}/authorize`);
    assert.equal(location.searchParams.get("client_id"), STRAVA_CLIENT_ID);
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("scope"), "activity:read_all,activity:write");
    assert.ok(location.searchParams.get("redirect_uri").endsWith("/strava-callback"));
    assert.ok(location.searchParams.get("state"), "expected a signed state param");
  });

  test("GET /strava-callback rejects a missing/invalid state", async () => {
    const res = await callback("code=some-code&state=garbage");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "slipstreamirl://redirect?strava=error");
    assert.equal(tokenRequests.length, 0, "must not exchange a code without a valid state");
  });

  test("GET /strava-callback rejects an expired state", async () => {
    const expired = signStravaState("twitch-expired", JWT_SECRET, { ttlSeconds: 60, now: Date.now() - 10 * 60 * 1000 });
    const res = await callback(`code=some-code&state=${encodeURIComponent(expired)}`);
    assert.equal(res.headers.get("location"), "slipstreamirl://redirect?strava=error");
    assert.equal(tokenRequests.length, 0);
  });

  test("GET /strava-callback rejects a channel push token presented as state (cross-token-kind replay)", async () => {
    const channelToken = signChannelToken("twitch-1", JWT_SECRET);
    const res = await callback(`code=some-code&state=${encodeURIComponent(channelToken)}`);
    assert.equal(res.headers.get("location"), "slipstreamirl://redirect?strava=error");
    assert.equal(tokenRequests.length, 0);
  });

  test("full link round trip: authorize -> callback stores the encrypted link under the state's twitchId, never the raw refresh token", async () => {
    twitchIdToReturn = "twitch-full-flow";
    const authRes = await authorize();
    const state = new URL(authRes.headers.get("location")).searchParams.get("state");

    const cbRes = await callback(`code=auth-code-123&state=${encodeURIComponent(state)}&scope=read,activity:write,activity:read_all`);
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get("location"), "slipstreamirl://redirect?strava=linked");

    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0].get("grant_type"), "authorization_code");
    assert.equal(tokenRequests[0].get("code"), "auth-code-123");
    assert.equal(tokenRequests[0].get("client_id"), STRAVA_CLIENT_ID);
    assert.equal(tokenRequests[0].get("client_secret"), STRAVA_CLIENT_SECRET);

    const raw = upstashStore.get("user:twitch-full-flow");
    assert.ok(raw, "expected a record written under the twitchId bound in the state, not any caller-supplied id");
    const record = JSON.parse(raw);
    assert.equal(record.strava.athleteId, 555);
    assert.equal(record.strava.scope, "read,activity:write,activity:read_all");
    assert.ok(record.strava.refreshTokenEnc);
    assert.doesNotMatch(JSON.stringify(record), /refresh-abc/, "the raw refresh token must never reach Upstash in plaintext");
  });

  test("GET /strava-callback signals error and stores nothing when Strava's token exchange fails", async () => {
    twitchIdToReturn = "twitch-exchange-fail";
    const authRes = await authorize();
    const state = new URL(authRes.headers.get("location")).searchParams.get("state");
    tokenStatus = 400;
    tokenResponse = { message: "Bad Request" };

    const cbRes = await callback(`code=bad-code&state=${encodeURIComponent(state)}`);
    assert.equal(cbRes.headers.get("location"), "slipstreamirl://redirect?strava=error");
    assert.equal(upstashStore.has("user:twitch-exchange-fail"), false);
  });

  test("GET /strava-callback signals error when Strava's authorize step redirected without a code (denied consent)", async () => {
    twitchIdToReturn = "twitch-denied";
    const authRes = await authorize();
    const state = new URL(authRes.headers.get("location")).searchParams.get("state");
    const cbRes = await callback(`state=${encodeURIComponent(state)}`); // no code
    assert.equal(cbRes.headers.get("location"), "slipstreamirl://redirect?strava=error");
    assert.equal(tokenRequests.length, 0);
  });

  describe("POST /strava-deauthorize", () => {
    test("rejects bad json", async () => {
      const res = await fetch(`${server.baseHttp}/strava-deauthorize`, { method: "POST", body: "not json" });
      assert.equal(res.status, 400);
    });

    test("requires twitchAccessToken", async () => {
      const res = await fetch(`${server.baseHttp}/strava-deauthorize`, { method: "POST", body: JSON.stringify({}) });
      assert.equal(res.status, 400);
    });

    test("rejects an unverifiable Twitch token", async () => {
      const res = await deauthorizeCall("invalid-token");
      assert.equal(res.status, 401);
    });

    test("a user who was never linked gets 404, and nothing is called on Strava", async () => {
      twitchIdToReturn = "twitch-never-linked";
      const res = await deauthorizeCall();
      assert.equal(res.status, 404);
      assert.equal(tokenRequests.length, 0);
      assert.equal(deauthRequests.length, 0);
    });

    async function linkUser(twitchId) {
      twitchIdToReturn = twitchId;
      const authRes = await authorize();
      const state = new URL(authRes.headers.get("location")).searchParams.get("state");
      await callback(`code=auth-code-for-${twitchId}&state=${encodeURIComponent(state)}&scope=activity:read_all,activity:write`);
    }

    test("happy path: refreshes, revokes at Strava with the fresh access token, THEN deletes the local link", async () => {
      const twitchId = "twitch-deauth-happy";
      await linkUser(twitchId);
      assert.ok(upstashStore.get(`user:${twitchId}`), "sanity: link was stored");

      tokenRequests = [];
      const res = await deauthorizeCall();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });

      assert.equal(tokenRequests.length, 1);
      assert.equal(tokenRequests[0].get("grant_type"), "refresh_token");
      assert.equal(tokenRequests[0].get("refresh_token"), "refresh-abc");

      assert.equal(deauthRequests.length, 1);
      assert.equal(deauthRequests[0].get("access_token"), "access-abc");

      const record = JSON.parse(upstashStore.get(`user:${twitchId}`));
      assert.equal(record.strava, null, "the link must be forgotten locally only after Strava confirms revocation");
    });

    test("if the refresh fails, the local link is kept (not deleted) and Strava's deauthorize is never called", async () => {
      const twitchId = "twitch-deauth-refresh-fail";
      await linkUser(twitchId);
      tokenStatus = 401;
      tokenResponse = { message: "Unauthorized" };

      const res = await deauthorizeCall();
      assert.equal(res.status, 502);
      assert.equal(deauthRequests.length, 0);

      const record = JSON.parse(upstashStore.get(`user:${twitchId}`));
      assert.notEqual(record.strava, null, "must not silently forget a link we never actually revoked at Strava");
    });

    test("if Strava's deauthorize call itself fails, the local link is kept (not deleted)", async () => {
      const twitchId = "twitch-deauth-revoke-fail";
      await linkUser(twitchId);
      deauthStatus = 500;

      const res = await deauthorizeCall();
      assert.equal(res.status, 502);

      const record = JSON.parse(upstashStore.get(`user:${twitchId}`));
      assert.notEqual(record.strava, null);
    });
  });
});

describe("Strava linking is unreachable in single-tenant mode", () => {
  let server;
  before(async () => { server = await startServer({ RELAY_TOKEN: "legacy-token" }); });
  after(async () => { await server.stop(); });

  test("all three endpoints 404", async () => {
    const a = await fetch(`${server.baseHttp}/strava-authorize?twitchAccessToken=x`, { redirect: "manual" });
    assert.equal(a.status, 404);
    const b = await fetch(`${server.baseHttp}/strava-callback?code=x&state=y`, { redirect: "manual" });
    assert.equal(b.status, 404);
    const c = await fetch(`${server.baseHttp}/strava-deauthorize`, { method: "POST", body: JSON.stringify({ twitchAccessToken: "x" }) });
    assert.equal(c.status, 404);
  });
});

describe("Strava linking in multi-tenant mode with the user store not configured", () => {
  let twitchStub, server;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "twitch-x" }] }));
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: "test-jwt-secret",
      STRAVA_CLIENT_ID: "cid",
      STRAVA_CLIENT_SECRET: "csecret",
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      // TOKEN_ENCRYPTION_KEY / UPSTASH_* deliberately absent.
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
  });

  test("GET /strava-authorize reports 503 rather than crashing or issuing anything", async () => {
    const res = await fetch(`${server.baseHttp}/strava-authorize?twitchAccessToken=x`, { redirect: "manual" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "user store not configured");
  });

  test("POST /strava-deauthorize reports 503 rather than crashing", async () => {
    const res = await fetch(`${server.baseHttp}/strava-deauthorize`, { method: "POST", body: JSON.stringify({ twitchAccessToken: "x" }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "user store not configured");
  });
});

describe("Strava linking in multi-tenant mode with the user store configured but Strava client credentials missing", () => {
  let twitchStub, upstashStub, server;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "twitch-x" }] }));
    });
    upstashStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: null }));
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: "test-jwt-secret",
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      TOKEN_ENCRYPTION_KEY,
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashStub.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: "test-upstash-token",
      // STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET deliberately absent.
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => upstashStub.close(r));
  });

  test("GET /strava-authorize reports 503 strava-not-configured", async () => {
    const res = await fetch(`${server.baseHttp}/strava-authorize?twitchAccessToken=x`, { redirect: "manual" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "strava not configured");
  });
});
