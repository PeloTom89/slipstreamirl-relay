// tools/download-stats.js — a single global download counter, backed by the
// same Upstash Redis REST API this repo already uses for the per-user store
// (tools/user-store.js). CommonJS for the same reason as that module:
// server.js is CommonJS and require()s this synchronously at request time.
//
// This is NOT per-user data — it doesn't belong in tools/user-store.js's
// `user:{twitchId}` shape. It's one fixed key (`stats:android-downloads`)
// incremented on every hit of GET /download/android. A download counter is
// exactly the kind of durable state user-store.js already establishes is
// fine to keep in Upstash — this is unrelated to stripe-entitlement.js's
// deliberate "no durable local state" rule (that's a different module,
// different reason — see AGENTS.md).
//
// Fail-safe contract:
//   - increment() NEVER throws and NEVER blocks meaningfully. If Upstash is
//     unreachable/slow or UPSTASH_* is unset, it logs and resolves — the
//     caller redirects the download regardless.
//   - The status page reads the count from an in-memory cache (peek()), never
//     a blocking network call on the request path — `GET /` is also the
//     process's health probe and must not depend on Redis being fast. The
//     cache is warmed by increment()'s own INCR response and by refresh(),
//     which the status handler kicks off without awaiting.
//   - Every fetch carries an AbortSignal timeout so a hung Upstash connection
//     can never pin a request or leak forever.
//
// UPSTASH_API_BASE is the same base-URL test seam as user-store.js — defaults
// to UPSTASH_REDIS_REST_URL, pointed at a local stub in tests. Not an
// operator-facing config option, not documented in README's env var tables.

const DOWNLOAD_KEY = "stats:android-downloads";

function createDownloadStats({
  upstashUrl = process.env.UPSTASH_REDIS_REST_URL,
  upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN,
  apiBase = process.env.UPSTASH_API_BASE || process.env.UPSTASH_REDIS_REST_URL,
  fetchImpl = globalThis.fetch,
  key = DOWNLOAD_KEY,
  timeoutMs = 2000,
  logger = console,
} = {}) {
  const configured = Boolean(upstashUrl && upstashToken);
  let cached = null; // last known count, or null if never successfully read

  function withTimeout() {
    return AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  }

  function rememberIfFinite(raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) cached = n;
  }

  async function increment() {
    if (!configured) {
      logger.warn("download-stats: Upstash not configured, skipping increment for " + key);
      return;
    }
    try {
      const r = await fetchImpl(apiBase + "/incr/" + encodeURIComponent(key), {
        method: "POST",
        headers: { Authorization: "Bearer " + upstashToken },
        signal: withTimeout(),
      });
      if (!r.ok) throw new Error("upstash incr failed: " + r.status);
      // INCR returns the new value — use it to keep the status-page cache warm.
      const j = await r.json();
      rememberIfFinite(j.result);
    } catch (e) {
      logger.warn("download-stats: increment failed for " + key + ": " + e.message);
    }
  }

  // Fetch the current count into the cache. Never throws. Returns the cache
  // value (post-refresh) — null if it has never been read successfully.
  async function refresh() {
    if (!configured) return null;
    try {
      const r = await fetchImpl(apiBase + "/get/" + encodeURIComponent(key), {
        headers: { Authorization: "Bearer " + upstashToken },
        signal: withTimeout(),
      });
      if (!r.ok) throw new Error("upstash get failed: " + r.status);
      const j = await r.json();
      if (j.result === null || j.result === undefined) cached = 0;
      else rememberIfFinite(j.result);
    } catch (e) {
      logger.warn("download-stats: refresh failed for " + key + ": " + e.message);
    }
    return cached;
  }

  // Synchronous, non-blocking read of the last known count for display.
  function peek() {
    return cached;
  }

  return { increment, refresh, peek, configured };
}

module.exports = { createDownloadStats, DOWNLOAD_KEY };
