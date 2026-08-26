// tools/relay-anthropic-key.test.mjs — integration tests for
// POST /settings/anthropic-key against a real spawned server.js, with local
// HTTP stubs standing in for Twitch Helix and Upstash's REST API
// (TWITCH_HELIX_BASE / UPSTASH_API_BASE overrides — test-only, see
// server.js/AGENTS.md). No live Twitch or Upstash credentials used anywhere
// here.

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

describe("POST /settings/anthropic-key (MULTI_TENANT + user store configured)", () => {
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

  async function setKey(body) {
    return fetch(`${server.baseHttp}/settings/anthropic-key`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  test("rejects bad json", async () => {
    const res = await fetch(`${server.baseHttp}/settings/anthropic-key`, { method: "POST", body: "not json" });
    assert.equal(res.status, 400);
  });

  test("requires twitchAccessToken", async () => {
    const res = await setKey({ anthropicApiKey: "sk-ant-abc" });
    assert.equal(res.status, 400);
  });

  test("rejects a non-string anthropicApiKey", async () => {
    const res = await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: 12345 });
    assert.equal(res.status, 400);
  });

  test("rejects an absurdly long anthropicApiKey", async () => {
    const res = await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: "a".repeat(500) });
    assert.equal(res.status, 400);
  });

  test("rejects an unverifiable Twitch token", async () => {
    const res = await setKey({ twitchAccessToken: "invalid-token", anthropicApiKey: "sk-ant-abc" });
    assert.equal(res.status, 401);
  });

  test("stores the key encrypted under the verified Twitch id, never a body-supplied id", async () => {
    twitchIdToReturn = "twitch-store-1";
    const res = await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: "sk-ant-secret-value" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    const raw = upstashStore.get("user:twitch-store-1");
    assert.ok(raw, "expected a record written under the verified twitchId");
    const record = JSON.parse(raw);
    assert.ok(record.anthropicApiKeyEnc, "expected the key to be stored (encrypted)");
    assert.doesNotMatch(JSON.stringify(record), /sk-ant-secret-value/, "the raw key must never reach Upstash in plaintext");
  });

  test("clears the stored key when anthropicApiKey is omitted", async () => {
    twitchIdToReturn = "twitch-clear-1";
    await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: "sk-ant-to-be-cleared" });
    assert.ok(JSON.parse(upstashStore.get("user:twitch-clear-1")).anthropicApiKeyEnc);

    const res = await setKey({ twitchAccessToken: "fake-access-token" });
    assert.equal(res.status, 200);
    const record = JSON.parse(upstashStore.get("user:twitch-clear-1"));
    assert.equal(record.anthropicApiKeyEnc, null);
  });

  test("clears the stored key when anthropicApiKey is an empty string", async () => {
    twitchIdToReturn = "twitch-clear-2";
    await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: "sk-ant-to-be-cleared" });
    assert.ok(JSON.parse(upstashStore.get("user:twitch-clear-2")).anthropicApiKeyEnc);

    const res = await setKey({ twitchAccessToken: "fake-access-token", anthropicApiKey: "" });
    assert.equal(res.status, 200);
    const record = JSON.parse(upstashStore.get("user:twitch-clear-2"));
    assert.equal(record.anthropicApiKeyEnc, null);
  });
});

describe("POST /settings/anthropic-key without user store configured", () => {
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
    const res = await fetch(`${server.baseHttp}/settings/anthropic-key`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-access-token", anthropicApiKey: "sk-ant-abc" }),
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /settings/anthropic-key outside MULTI_TENANT mode", () => {
  let server;

  before(async () => {
    server = await startServer({});
  });

  after(async () => {
    await server.stop();
  });

  test("404s", async () => {
    const res = await fetch(`${server.baseHttp}/settings/anthropic-key`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-access-token", anthropicApiKey: "sk-ant-abc" }),
    });
    assert.equal(res.status, 404);
  });
});
