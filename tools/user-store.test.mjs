// tools/user-store.test.mjs — tests for the Upstash-backed per-user store
// against a local stub HTTP server standing in for Upstash's REST endpoint
// (mirrors relay-entitlement.test.mjs's Twitch/Stripe stubs). No live Upstash
// credentials used anywhere here.

import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { createUserStore, parseEncryptionKey, encrypt, decrypt } from "./user-store.js";

// Minimal glob matcher for the stub's SCAN MATCH — only needs to support the
// "prefix*" shape this module actually sends ("user:*").
function globToRegExp(pattern) {
  const escaped = pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + escaped + "$");
}

function startStub() {
  const store = new Map();
  const requests = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        const getMatch = req.method === "GET" && req.url.match(/^\/get\/(.+)$/);
        const setMatch = req.method === "POST" && req.url.match(/^\/set\/(.+)$/);
        const scanMatch = req.method === "GET" && req.url.match(/^\/scan\/([^/]+)\/match\/([^/]+)\/count\/([^/?]+)/);
        if (getMatch) {
          const key = decodeURIComponent(getMatch[1]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: store.has(key) ? store.get(key) : null }));
          return;
        }
        if (setMatch) {
          const key = decodeURIComponent(setMatch[1]);
          store.set(key, body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: "OK" }));
          return;
        }
        if (scanMatch) {
          const cursor = parseInt(decodeURIComponent(scanMatch[1]), 10) || 0;
          const pattern = decodeURIComponent(scanMatch[2]);
          const count = parseInt(decodeURIComponent(scanMatch[3]), 10) || 10;
          const re = globToRegExp(pattern);
          const allKeys = [...store.keys()].filter((k) => re.test(k));
          const page = allKeys.slice(cursor, cursor + count);
          const nextCursor = cursor + count >= allKeys.length ? "0" : String(cursor + count);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: [nextCursor, page] }));
          return;
        }
        res.writeHead(404);
        res.end("not found in stub");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, store, requests, port: srv.address().port }));
  });
}

const VALID_KEY = crypto.randomBytes(32).toString("base64");

describe("parseEncryptionKey", () => {
  test("accepts a 32-byte base64 key", () => {
    const buf = parseEncryptionKey(VALID_KEY);
    assert.equal(buf.length, 32);
  });

  test("accepts a 32-byte hex key", () => {
    const hex = crypto.randomBytes(32).toString("hex");
    const buf = parseEncryptionKey(hex);
    assert.equal(buf.length, 32);
  });

  test("rejects a missing key", () => {
    assert.throws(() => parseEncryptionKey(undefined), /TOKEN_ENCRYPTION_KEY/);
    assert.throws(() => parseEncryptionKey(""), /TOKEN_ENCRYPTION_KEY/);
  });

  test("rejects a key that doesn't decode to 32 bytes", () => {
    assert.throws(() => parseEncryptionKey("too-short"), /32 bytes/);
    assert.throws(() => parseEncryptionKey(Buffer.alloc(16).toString("base64")), /32 bytes/);
  });
});

describe("encrypt/decrypt round trip and tamper rejection", () => {
  const keyBuf = parseEncryptionKey(VALID_KEY);

  test("decrypt returns the original plaintext", () => {
    const enc = encrypt(keyBuf, "s3cr3t-refresh-token");
    assert.notEqual(enc, "s3cr3t-refresh-token");
    assert.equal(decrypt(keyBuf, enc), "s3cr3t-refresh-token");
  });

  test("each encryption uses a fresh IV (ciphertext differs across calls)", () => {
    const a = encrypt(keyBuf, "same-plaintext");
    const b = encrypt(keyBuf, "same-plaintext");
    assert.notEqual(a, b);
  });

  test("tampering with the auth tag is rejected on decrypt", () => {
    const enc = encrypt(keyBuf, "s3cr3t-refresh-token");
    const [iv, tag, ct] = enc.split(":");
    const tamperedTagBuf = Buffer.from(tag, "base64");
    tamperedTagBuf[0] ^= 0xff; // flip a bit
    const tampered = [iv, tamperedTagBuf.toString("base64"), ct].join(":");
    assert.throws(() => decrypt(keyBuf, tampered));
  });

  test("tampering with the ciphertext is rejected on decrypt", () => {
    const enc = encrypt(keyBuf, "s3cr3t-refresh-token");
    const [iv, tag, ct] = enc.split(":");
    const tamperedCtBuf = Buffer.from(ct, "base64");
    tamperedCtBuf[0] ^= 0xff;
    const tampered = [iv, tag, tamperedCtBuf.toString("base64")].join(":");
    assert.throws(() => decrypt(keyBuf, tampered));
  });
});

describe("createUserStore against a stubbed Upstash REST endpoint", () => {
  let stub, store;

  beforeEach(async () => {
    stub = await startStub();
    store = createUserStore({
      encryptionKey: VALID_KEY,
      upstashUrl: `http://127.0.0.1:${stub.port}`,
      upstashToken: "test-upstash-token",
    });
  });

  afterEach(async () => {
    if (stub) await new Promise((r) => stub.srv.close(r));
  });

  test("getUser of an unknown id returns null", async () => {
    assert.equal(await store.getUser("no-such-user"), null);
  });

  test("round trip: putStravaLink then getUser returns the linked record", async () => {
    await store.putStravaLink("twitch-1", { athleteId: 42, refreshToken: "raw-refresh-token", scope: "read,activity:read" });
    const record = await store.getUser("twitch-1");
    assert.equal(record.twitchId, "twitch-1");
    assert.equal(record.strava.athleteId, 42);
    assert.equal(record.strava.scope, "read,activity:read");
    assert.ok(record.strava.linkedAt);
    assert.ok(record.updatedAt);
    assert.notEqual(record.strava.refreshTokenEnc, "raw-refresh-token");
  });

  test("secrets reach the Upstash boundary as ciphertext, never plaintext", async () => {
    await store.putStravaLink("twitch-2", { athleteId: 7, refreshToken: "totally-secret-token", scope: "read" });
    await store.putAnthropicKey("twitch-2", "sk-ant-totally-secret-key");
    const setBodies = stub.requests.filter((r) => r.method === "POST").map((r) => r.body);
    for (const body of setBodies) {
      assert.doesNotMatch(body, /totally-secret-token/);
      assert.doesNotMatch(body, /sk-ant-totally-secret-key/);
    }
    // sanity: the encrypted forms ARE present somewhere in what was stored
    const record = await store.getUser("twitch-2");
    assert.ok(record.strava.refreshTokenEnc);
    assert.ok(record.anthropicApiKeyEnc);
  });

  test("getStravaRefreshToken / getAnthropicKey decrypt back to the original plaintext", async () => {
    await store.putStravaLink("twitch-3", { athleteId: 1, refreshToken: "refresh-abc", scope: "read" });
    await store.putAnthropicKey("twitch-3", "sk-ant-xyz");
    assert.equal(await store.getStravaRefreshToken("twitch-3"), "refresh-abc");
    assert.equal(await store.getAnthropicKey("twitch-3"), "sk-ant-xyz");
  });

  test("getStravaRefreshToken/getAnthropicKey return null when unset", async () => {
    await store.putStravaLink("twitch-4", { athleteId: 1, refreshToken: "refresh-abc", scope: "read" });
    assert.equal(await store.getAnthropicKey("twitch-4"), null);
    assert.equal(await store.getStravaRefreshToken("no-such-user"), null);
  });

  test("putAnthropicKey preserves an existing strava link, and vice versa", async () => {
    await store.putStravaLink("twitch-5", { athleteId: 9, refreshToken: "refresh-1", scope: "read" });
    await store.putAnthropicKey("twitch-5", "sk-ant-1");
    const record = await store.getUser("twitch-5");
    assert.equal(record.strava.athleteId, 9);
    assert.ok(record.anthropicApiKeyEnc);
  });

  test("deleteStravaLink clears the strava sub-object but leaves the rest", async () => {
    await store.putStravaLink("twitch-6", { athleteId: 3, refreshToken: "refresh-1", scope: "read" });
    await store.putAnthropicKey("twitch-6", "sk-ant-1");
    await store.deleteStravaLink("twitch-6");
    const record = await store.getUser("twitch-6");
    assert.equal(record.strava, null);
    assert.ok(record.anthropicApiKeyEnc, "anthropic key must be unaffected by a Strava disconnect");
    assert.equal(await store.getStravaRefreshToken("twitch-6"), null);
  });

  test("deleteStravaLink on an unknown id is a no-op, not an error", async () => {
    assert.equal(await store.deleteStravaLink("no-such-user"), null);
  });
});

describe("listLinkedUsers", () => {
  let stub, store;

  beforeEach(async () => {
    stub = await startStub();
    store = createUserStore({
      encryptionKey: VALID_KEY,
      upstashUrl: `http://127.0.0.1:${stub.port}`,
      upstashToken: "test-upstash-token",
      scanCount: 10, // small page size so multi-user tests exercise pagination
    });
  });

  afterEach(async () => {
    if (stub) await new Promise((r) => stub.srv.close(r));
  });

  test("returns [] when the store is empty", async () => {
    assert.deepEqual(await store.listLinkedUsers(), []);
  });

  test("returns only records with a live strava link, skipping anthropic-only records", async () => {
    await store.putStravaLink("has-strava-1", { athleteId: 1, refreshToken: "r1", scope: "read" });
    await store.putAnthropicKey("anthropic-only", "sk-ant-only");
    await store.putStravaLink("has-strava-2", { athleteId: 2, refreshToken: "r2", scope: "read" });

    const users = await store.listLinkedUsers();
    const twitchIds = users.map((u) => u.twitchId).sort();
    assert.deepEqual(twitchIds, ["has-strava-1", "has-strava-2"]);
    assert.ok(users.every((u) => u.strava && u.strava.athleteId));
  });

  test("excludes a record whose strava link was deleted", async () => {
    await store.putStravaLink("linked", { athleteId: 1, refreshToken: "r1", scope: "read" });
    await store.putStravaLink("unlinked", { athleteId: 2, refreshToken: "r2", scope: "read" });
    await store.deleteStravaLink("unlinked");

    const users = await store.listLinkedUsers();
    assert.deepEqual(users.map((u) => u.twitchId), ["linked"]);
  });

  test("follows the SCAN cursor across multiple pages rather than assuming one page", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `twitch-${i}`);
    for (const id of ids) {
      await store.putStravaLink(id, { athleteId: id, refreshToken: `r-${id}`, scope: "read" });
    }

    const users = await store.listLinkedUsers();
    assert.equal(users.length, 25);
    assert.deepEqual(users.map((u) => u.twitchId).sort(), ids.slice().sort());

    const scanRequests = stub.requests.filter((r) => r.url.startsWith("/scan/"));
    // scanCount 10 over 25 keys must take more than one page to fully drain.
    assert.ok(scanRequests.length > 1, `expected multiple SCAN pages, got ${scanRequests.length}`);
  });
});

describe("createUserStore fails loudly on a missing/malformed TOKEN_ENCRYPTION_KEY", () => {
  test("throws when the key is missing", () => {
    assert.throws(
      () => createUserStore({ upstashUrl: "http://127.0.0.1:1", upstashToken: "t", encryptionKey: undefined }),
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  test("throws when the key doesn't decode to 32 bytes", () => {
    assert.throws(
      () => createUserStore({ upstashUrl: "http://127.0.0.1:1", upstashToken: "t", encryptionKey: "short" }),
      /32 bytes/,
    );
  });

  test("throws when Upstash credentials are missing, even with a valid key", () => {
    assert.throws(() => createUserStore({ encryptionKey: VALID_KEY, upstashUrl: undefined, upstashToken: undefined }));
  });
});
