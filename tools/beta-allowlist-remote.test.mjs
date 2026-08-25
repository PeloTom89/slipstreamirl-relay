// tools/beta-allowlist-remote.test.mjs — unit tests for the optional remote
// beta-allowlist source (tools/beta-allowlist-remote.js). Uses an injected
// fetchImpl stub throughout, never real network — see
// tools/relay-entitlement.test.mjs for the end-to-end version wired through
// a real spawned server.js.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAllowlistIds, createRemoteAllowlist } from "./beta-allowlist-remote.js";

describe("parseAllowlistIds", () => {
  test("accepts comma- and newline-separated numeric Twitch ids", () => {
    assert.deepEqual(parseAllowlistIds("123,456\n789"), ["123", "456", "789"]);
  });

  test("trims whitespace around ids", () => {
    assert.deepEqual(parseAllowlistIds("  123 , 456  \n  789  "), ["123", "456", "789"]);
  });

  test("drops blanks, stray commas, and whitespace-only entries", () => {
    assert.deepEqual(parseAllowlistIds("123,,  ,\n\n456,"), ["123", "456"]);
  });

  test("drops non-numeric junk entries (never a bypass into something else)", () => {
    assert.deepEqual(parseAllowlistIds("123,abc,45.6,12e3,-99,456"), ["123", "456"]);
  });

  test("dedupes repeated ids", () => {
    assert.deepEqual(parseAllowlistIds("123,123,456,123"), ["123", "456"]);
  });

  test("caps the number of accepted ids at maxIds", () => {
    const many = Array.from({ length: 10 }, (_, i) => String(1000 + i)).join(",");
    const result = parseAllowlistIds(many, { maxIds: 3 });
    assert.deepEqual(result, ["1000", "1001", "1002"]);
  });

  test("an empty or garbage-only string yields no ids", () => {
    assert.deepEqual(parseAllowlistIds(""), []);
    assert.deepEqual(parseAllowlistIds("<html>404 not found</html>"), []);
  });

  test("null/undefined input yields no ids rather than throwing", () => {
    assert.deepEqual(parseAllowlistIds(null), []);
    assert.deepEqual(parseAllowlistIds(undefined), []);
  });
});

// Minimal fake Response with a streaming body, so the bounded-read path in
// beta-allowlist-remote.js (readBounded) is exercised the same way it would
// be against Node's real fetch/undici Response.
function fakeResponse({ ok = true, status = 200, text = "" } = {}) {
  const bytes = Buffer.from(text, "utf8");
  return {
    ok,
    status,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
        };
      },
    },
    async text() {
      return text;
    },
  };
}

describe("createRemoteAllowlist", () => {
  test("returns null when no url is configured (remote source disabled)", () => {
    assert.equal(createRemoteAllowlist({}), null);
    assert.equal(createRemoteAllowlist({ url: "" }), null);
  });

  test("a successful fetch populates getIds() and status() reports 'ok'", async () => {
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => fakeResponse({ text: "111,222" }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()].sort(), ["111", "222"]);
    assert.equal(remote.status().state, "ok");
  });

  test("a network error keeps the last known good list and flips status to 'stale'", async () => {
    let shouldFail = false;
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => {
        if (shouldFail) throw new Error("connection refused");
        return fakeResponse({ text: "111,222" });
      },
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()].sort(), ["111", "222"]);

    shouldFail = true;
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()].sort(), ["111", "222"], "list must survive a network error");
    assert.equal(remote.status().state, "stale");
  });

  test("a non-2xx response keeps the last known good list", async () => {
    let statusToReturn = 200;
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => fakeResponse({ ok: statusToReturn === 200, status: statusToReturn, text: "111" }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()], ["111"]);

    statusToReturn = 500;
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()], ["111"], "list must survive a 5xx response");
    assert.equal(remote.status().state, "stale");
  });

  test("a malformed/unparseable response (zero valid ids) does not wipe the list", async () => {
    let bodyToReturn = "111,222";
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => fakeResponse({ text: bodyToReturn }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()].sort(), ["111", "222"]);

    bodyToReturn = "<html>oops, wrong url</html>";
    await remote.fetchOnce();
    assert.deepEqual(
      [...remote.getIds()].sort(),
      ["111", "222"],
      "a typo/garbage response must not silently revoke everyone"
    );
    assert.equal(remote.status().state, "stale");
  });

  test("never having fetched successfully reports 'never-fetched', not a crash", async () => {
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => { throw new Error("unreachable"); },
    });
    assert.equal(remote.status().state, "never-fetched");
    await remote.fetchOnce();
    assert.equal(remote.status().state, "never-fetched");
    assert.deepEqual([...remote.getIds()], []);
  });

  test("a response larger than maxBytes is rejected without wiping the prior list", async () => {
    let big = false;
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      maxBytes: 10,
      fetchImpl: async () => fakeResponse({ text: big ? "1".repeat(1000) : "111" }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()], ["111"]);

    big = true;
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()], ["111"], "an oversized response must not replace the list");
    assert.equal(remote.status().state, "stale");
  });

  test("a fetch that never resolves is aborted once timeoutMs elapses, and the prior list survives", async () => {
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      timeoutMs: 30,
      fetchImpl: async () => fakeResponse({ text: "111" }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()], ["111"]);

    const hanging = createRemoteAllowlist({
      url: "http://example.invalid/list",
      timeoutMs: 30,
      fetchImpl: (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await hanging.fetchOnce();
    assert.equal(hanging.status().state, "never-fetched");
  });

  test("ids accepted from the remote source are still validated (junk in the body never grants a junk id)", async () => {
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      fetchImpl: async () => fakeResponse({ text: "111, not-an-id, 222, <script>" }),
    });
    await remote.fetchOnce();
    assert.deepEqual([...remote.getIds()].sort(), ["111", "222"]);
  });

  test("start()/stop() poll on the configured interval and can be torn down", async () => {
    let calls = 0;
    const remote = createRemoteAllowlist({
      url: "http://example.invalid/list",
      intervalMs: 10,
      fetchImpl: async () => { calls++; return fakeResponse({ text: "111" }); },
    });
    remote.start();
    await new Promise((r) => setTimeout(r, 45));
    remote.stop();
    const callsAtStop = calls;
    assert.ok(callsAtStop >= 2, "expected more than the initial fetch within the interval window");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, callsAtStop, "no further fetches after stop()");
  });
});
