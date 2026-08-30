// tools/download-stats.test.mjs — unit tests for the Android download counter
// helper against a local Upstash REST stub. The load-bearing property here is
// that increment() NEVER throws, even when Upstash errors or is unconfigured.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDownloadStats } from "./download-stats.js";

const silent = { warn() {}, error() {}, log() {} };

describe("createDownloadStats", () => {
  test("increment posts INCR to the right key and never throws on success", async () => {
    const calls = [];
    const stats = createDownloadStats({
      upstashUrl: "http://stub",
      upstashToken: "t",
      apiBase: "http://stub",
      logger: silent,
      fetchImpl: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ result: 1 }) };
      },
    });
    await stats.increment();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://stub/incr/stats%3Aandroid-downloads");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer t");
  });

  test("increment warms the peek() cache from the INCR response", async () => {
    const stats = createDownloadStats({
      upstashUrl: "http://stub", upstashToken: "t", apiBase: "http://stub", logger: silent,
      fetchImpl: async () => ({ ok: true, json: async () => ({ result: 7 }) }),
    });
    assert.equal(stats.peek(), null);
    await stats.increment();
    assert.equal(stats.peek(), 7);
  });

  test("increment swallows a non-ok response", async () => {
    const stats = createDownloadStats({
      upstashUrl: "http://stub", upstashToken: "t", apiBase: "http://stub", logger: silent,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    await assert.doesNotReject(stats.increment());
  });

  test("increment swallows a thrown fetch error", async () => {
    const stats = createDownloadStats({
      upstashUrl: "http://stub", upstashToken: "t", apiBase: "http://stub", logger: silent,
      fetchImpl: async () => { throw new Error("network down"); },
    });
    await assert.doesNotReject(stats.increment());
  });

  test("increment is a no-op when Upstash is unconfigured", async () => {
    let called = false;
    const stats = createDownloadStats({
      upstashUrl: "", upstashToken: "", logger: silent,
      fetchImpl: async () => { called = true; return { ok: true }; },
    });
    await stats.increment();
    assert.equal(called, false);
    assert.equal(stats.configured, false);
  });

  test("refresh returns the numeric count, 0 for a missing key, and keeps the last known value on failure", async () => {
    const mk = (fetchImpl) => createDownloadStats({
      upstashUrl: "http://stub", upstashToken: "t", apiBase: "http://stub", logger: silent, fetchImpl,
    });
    assert.equal(await mk(async () => ({ ok: true, json: async () => ({ result: "42" }) })).refresh(), 42);
    assert.equal(await mk(async () => ({ ok: true, json: async () => ({ result: null }) })).refresh(), 0);
    // a failing refresh never throws and leaves peek() at its prior value (null here)
    const failing = mk(async () => ({ ok: false, status: 500 }));
    assert.equal(await failing.refresh(), null);
    assert.equal(failing.peek(), null);
    await assert.doesNotReject(mk(async () => { throw new Error("x"); }).refresh());
  });

  test("refresh returns null and does no fetch when unconfigured", async () => {
    let called = false;
    const stats = createDownloadStats({
      upstashUrl: "", upstashToken: "", logger: silent,
      fetchImpl: async () => { called = true; return { ok: true }; },
    });
    assert.equal(await stats.refresh(), null);
    assert.equal(stats.peek(), null);
    assert.equal(called, false);
  });
});
