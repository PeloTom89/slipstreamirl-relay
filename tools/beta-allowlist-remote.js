// tools/beta-allowlist-remote.js — optional remote source for the beta
// allowlist (server.js's BETA_ALLOWLIST_TWITCH_IDS env var), so the operator
// can add a beta tester by editing a URL (a GitHub Gist raw link is the
// intended use) instead of redeploying — an env var change redeploys the
// relay, which drops connections and clears in-memory ride state. CommonJS
// for the same reason as stripe-entitlement.js/channel-token.js: server.js
// is CommonJS and requires this at startup — see AGENTS.md.
//
// The remote content is untrusted network input (README.md "Beta allowlist"
// warns a public gist is effectively public — Twitch ids aren't secret, but
// who gets free access is disclosed). Design:
//   - Format is identical to the env var's: a comma- and/or newline-separated
//     list of Twitch numeric ids. Anything that isn't a plausible Twitch id
//     (digits only, sane length) is dropped silently, and the accepted count
//     is capped — a compromised or fat-fingered source can only ever grant
//     access to ids that pass validation, never do anything else.
//   - A response that fails to fetch (network error, timeout, non-2xx) or
//     that yields zero valid ids (garbage/HTML/empty body — most likely a
//     typo or an outage, not a deliberate "revoke everyone") never replaces
//     the last known good list. The only way this module's output set
//     shrinks is a *fetch that succeeds* and *still contains at least one*
//     valid id — i.e. removing individual testers from the source works,
//     emptying it entirely does not (by design, so a blank/broken source
//     can't silently revoke every beta tester — see README.md).
//   - The fetch itself is bounded: a timeout, and a maximum response size
//     enforced by aborting the read once exceeded (not just checking after
//     buffering the whole thing) so a huge or slow response can't be used to
//     tie up the relay.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — see README.md "Beta allowlist"
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB — a list of ids never needs to be bigger
const DEFAULT_MAX_IDS = 500;

const TWITCH_ID_RE = /^[0-9]{1,20}$/;

// Same lenient split as the env var parser: commas or newlines, trimmed,
// blanks dropped, only digit-only entries kept, deduped, capped.
function parseAllowlistIds(text, { maxIds = DEFAULT_MAX_IDS } = {}) {
  const ids = [];
  const seen = new Set();
  for (const raw of String(text == null ? "" : text).split(/[,\r\n]+/)) {
    const id = raw.trim();
    if (!id || !TWITCH_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= maxIds) break;
  }
  return ids;
}

// Reads a fetch Response body up to maxBytes, aborting once exceeded rather
// than buffering an unbounded amount first. Falls back to a plain .text()
// read (then a post-hoc size check) if the runtime's Response has no
// streaming reader — keeps this usable against simple test stubs.
async function readBounded(response, maxBytes, controller) {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response too large");
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      controller.abort();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// { url } required to do anything; returns null when no remote source is
// configured, which callers treat as "remote allowlist disabled".
function createRemoteAllowlist({
  url,
  fetchImpl = fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxIds = DEFAULT_MAX_IDS,
  now = Date.now,
  onLog = () => {},
} = {}) {
  if (!url) return null;

  let ids = new Set(); // last known good, remote-sourced ids only
  let everSucceeded = false;
  let lastSuccessAt = null;
  let lastErrorMessage = null;
  let timer = null;

  async function fetchOnce() {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await readBounded(res, maxBytes, controller);
      const parsed = parseAllowlistIds(text, { maxIds });
      if (parsed.length === 0) {
        // Zero valid ids: either genuinely empty, or garbage/HTML/typo — we
        // can't tell them apart, so per the module's design we treat this as
        // "don't trust it" and keep whatever we had. See module header.
        throw new Error("no valid Twitch ids found in response");
      }
      ids = new Set(parsed);
      everSucceeded = true;
      lastSuccessAt = now();
      lastErrorMessage = null;
      onLog("ok", { count: ids.size });
    } catch (e) {
      lastErrorMessage = (e && e.message) || String(e);
      onLog("error", { error: lastErrorMessage });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  function start() {
    fetchOnce();
    timer = setInterval(fetchOnce, intervalMs);
    if (timer.unref) timer.unref(); // never keep the process alive by itself
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getIds() {
    return ids;
  }

  // "ok"            — last fetch succeeded.
  // "stale"          — has succeeded before, but the most recent attempt failed
  //                     (still serving the last known good list).
  // "never-fetched"  — no successful fetch yet (serving nothing from this source).
  function status() {
    if (!everSucceeded) return { state: "never-fetched", lastErrorMessage };
    return {
      state: lastErrorMessage ? "stale" : "ok",
      count: ids.size,
      lastSuccessAt,
      lastErrorMessage,
    };
  }

  return { start, stop, getIds, status, fetchOnce };
}

module.exports = {
  parseAllowlistIds,
  createRemoteAllowlist,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_IDS,
};
