// tools/relay-android-download.test.mjs — integration tests for
// GET /download/android against a real spawned server.js, with a local HTTP
// stub standing in for Upstash's REST API (UPSTASH_API_BASE / the
// UPSTASH_REDIS_REST_URL override — test-only, see server.js/AGENTS.md). No
// live Upstash credentials used. The important case here is the fail-safe:
// an Upstash INCR failure must still 302 to the build.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer } from "./spawn-relay.mjs";

function startStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const APK_URL = "https://expo.dev/artifacts/eas/abc123.apk";

describe("GET /download/android", () => {
  test("503 when ANDROID_APK_URL is unset", async () => {
    const server = await startServer({ ANDROID_APK_URL: "" });
    try {
      const r = await fetch(`${server.baseHttp}/download/android`, { redirect: "manual" });
      assert.equal(r.status, 503);
      assert.match(await r.text(), /not currently available/i);
    } finally {
      await server.stop();
    }
  });

  describe("with ANDROID_APK_URL + Upstash stub", () => {
    let upstashStub, server;
    // Initialized here (not only in beforeEach) so the stub is safe to hit
    // during the `before` hook itself — startServer polls `GET /`, which now
    // reads the counter from Upstash.
    let store = new Map();
    let failIncr = false;

    before(async () => {
      upstashStub = await startStub((req, res) => {
       try {
        const incr = req.method === "POST" && req.url.match(/^\/incr\/(.+)$/);
        const get = req.method === "GET" && req.url.match(/^\/get\/(.+)$/);
        if (incr) {
          if (failIncr) { res.writeHead(500); res.end("boom"); return; }
          const key = decodeURIComponent(incr[1]);
          store.set(key, (store.get(key) || 0) + 1);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: store.get(key) }));
          return;
        }
        if (get) {
          const key = decodeURIComponent(get[1]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result: store.has(key) ? String(store.get(key)) : null }));
          return;
        }
        res.writeHead(404); res.end("not found in upstash stub");
       } catch (e) {
        res.writeHead(500); res.end("stub error: " + e.message);
       }
      });

      server = await startServer({
        ANDROID_APK_URL: APK_URL,
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${upstashStub.address().port}`,
        UPSTASH_REDIS_REST_TOKEN: "test-upstash-token",
      });
    });

    after(async () => {
      await server.stop();
      await new Promise((r) => upstashStub.close(r));
    });

    beforeEach(() => {
      store = new Map();
      failIncr = false;
    });

    test("302s to ANDROID_APK_URL and increments the counter", async () => {
      const r = await fetch(`${server.baseHttp}/download/android`, { redirect: "manual" });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), APK_URL);
      assert.equal(store.get("stats:android-downloads"), 1);

      await fetch(`${server.baseHttp}/download/android`, { redirect: "manual" });
      assert.equal(store.get("stats:android-downloads"), 2);
    });

    test("still 302s to the right URL when the Upstash increment fails", async () => {
      failIncr = true;
      const r = await fetch(`${server.baseHttp}/download/android`, { redirect: "manual" });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), APK_URL);
      assert.ok(!store.has("stats:android-downloads"));
    });

    test("status page surfaces the download count", async () => {
      await fetch(`${server.baseHttp}/download/android`, { redirect: "manual" });
      const r = await fetch(`${server.baseHttp}/`);
      assert.match(await r.text(), /1 android downloads/);
    });
  });
});
