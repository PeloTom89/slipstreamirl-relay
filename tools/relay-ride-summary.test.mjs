// tools/relay-ride-summary.test.mjs — integration tests for
// POST /ride-summary against a real spawned server.js, with local HTTP
// stubs standing in for Twitch Helix and Upstash's REST API
// (TWITCH_HELIX_BASE / UPSTASH_API_BASE overrides — test-only, see
// server.js/AGENTS.md). No live Twitch or Upstash credentials used anywhere
// here. This endpoint used to commit into this repo via GITHUB_CONTENT_PAT
// (a GitHub Contents API PUT) — see git history / AGENTS.md for that old
// mechanism; this suite covers the new per-user-store version only.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { startServer } from "./spawn-relay.mjs";

function startStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

describe("POST /ride-summary (MULTI_TENANT + user store configured)", () => {
  const JWT_SECRET = "test-jwt-secret";

  let twitchStub, upstashStub, server;
  let twitchIdToReturn = "twitch-1";
  let upstashStore;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const authHeader = req.headers["authorization"] || "";
      if (authHeader === "Bearer invalid-token") { res.end(JSON.stringify({ data: [] })); return; }
      res.end(JSON.stringify({ data: [{ id: twitchIdToReturn }] }));
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
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      TOKEN_ENCRYPTION_KEY,
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashStub.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: "test-upstash-token",
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => upstashStub.close(r));
  });

  beforeEach(() => {
    upstashStore = new Map();
  });

  async function postSummary(body) {
    return fetch(`${server.baseHttp}/ride-summary`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  test("rejects bad json", async () => {
    const res = await fetch(`${server.baseHttp}/ride-summary`, { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
  });

  test("requires twitchAccessToken", async () => {
    const res = await postSummary({ summary: "Great ride today." });
    assert.equal(res.status, 400);
  });

  test("requires a non-empty summary", async () => {
    const res = await postSummary({ twitchAccessToken: "fake-access-token", summary: "   " });
    assert.equal(res.status, 400);
  });

  test("rejects an unverifiable Twitch token", async () => {
    const res = await postSummary({ twitchAccessToken: "invalid-token", summary: "Great ride today." });
    assert.equal(res.status, 401);
  });

  test("stores the summary under the verified Twitch id, never a body-supplied id", async () => {
    twitchIdToReturn = "twitch-store-1";
    const res = await postSummary({
      twitchAccessToken: "fake-access-token",
      summary: "  Rode out to the lake and back.  ",
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    const raw = upstashStore.get("user:twitch-store-1");
    assert.ok(raw, "expected a record written under the verified twitchId");
    const record = JSON.parse(raw);
    assert.equal(record.rideSummary.summary, "Rode out to the lake and back.");
    assert.equal(record.rideSummary.recordedAt, "2026-01-01T00:00:00.000Z");
  });

  test("defaults recordedAt to now when omitted", async () => {
    twitchIdToReturn = "twitch-store-2";
    const res = await postSummary({ twitchAccessToken: "fake-access-token", summary: "No timestamp given." });
    assert.equal(res.status, 200);
    const record = JSON.parse(upstashStore.get("user:twitch-store-2"));
    assert.ok(record.rideSummary.recordedAt);
  });
});

describe("POST /ride-summary without user store configured", () => {
  let twitchStub, server;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "twitch-1" }] }));
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: "test-jwt-secret",
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      // No TOKEN_ENCRYPTION_KEY/UPSTASH_* — user store stays unconfigured.
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
  });

  test("503s before ever touching Twitch identity", async () => {
    const res = await fetch(`${server.baseHttp}/ride-summary`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-access-token", summary: "Great ride today." }),
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /ride-summary outside MULTI_TENANT mode", () => {
  let server;

  before(async () => {
    server = await startServer({});
  });

  after(async () => {
    await server.stop();
  });

  test("404s", async () => {
    const res = await fetch(`${server.baseHttp}/ride-summary`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-access-token", summary: "Great ride today." }),
    });
    assert.equal(res.status, 404);
  });
});
