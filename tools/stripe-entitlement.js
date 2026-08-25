// tools/stripe-entitlement.js — Stripe-backed entitlement for multi-tenant
// channel-token issuance (server.js's POST /channel-token, POST /stripe-webhook).
// CommonJS for the same reason as channel-token.js: server.js is CommonJS and
// requires this synchronously — see AGENTS.md.
//
// Design (evaluated against server.js's own comment on Render's free plan:
// ephemeral filesystem, sleeps on inactivity — see README.md "Stripe
// entitlement" for the full writeup):
//
//   - Stripe is the sole source of truth. There is no durable local store of
//     who has paid. A local file or a plain in-memory map with nothing to
//     rebuild it from would silently un-entitle every paying customer on the
//     next restart/sleep — exactly the failure this module is built to avoid.
//   - The Twitch<->Stripe identity link lives in Stripe itself, as
//     `metadata.twitch_id` set on the Subscription. Normally the operator's
//     Payment Link/Checkout config puts it there directly (see README). The
//     one exception: `client_reference_id` (Checkout's own field for "who is
//     this") lives ONLY on the Checkout Session, which reconcile() can never
//     re-query later — so on `checkout.session.completed` this module makes
//     its one and only write, copying that id onto the Subscription's
//     `metadata.twitch_id` via createSubscriptionMetadataWriter. That write
//     is what makes the link durable in Stripe instead of dying with the
//     in-memory cache on the next restart/sleep. Every other call this module
//     makes is a read (webhook verification is pure crypto; reconciliation is
//     a Search/Get call).
//   - A short-lived in-memory cache, keyed by Twitch id, is kept warm by
//     Stripe webhooks (applyStripeEvent) so the common case (token renewal
//     for someone already seen) needs no network call at all.
//   - On a cache miss — a Twitch id this process has never seen, or an entry
//     that's aged past its grace window — isEntitled() reconciles with one
//     read-only Stripe Search API call keyed on the same `metadata.twitch_id`.
//     This is what makes a Render sleep/restart harmless: nothing durable was
//     ever needed, because Stripe already durably holds the twitch_id and the
//     subscription status.
//   - Never a live check on the hot GPS-push path (POST /push, ~every 3s) —
//     only on token issuance (expected ~daily per streamer), which is the
//     only place that can afford a network round-trip at all.

const crypto = require("crypto");

const ENTITLING_STATUSES = new Set(["active", "trialing"]);

// ---- Webhook signature verification (Stripe's documented scheme) ----
// Stripe-Signature header: "t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]"
// (multiple v1 values occur during secret rotation; v0 is deprecated and
// ignored). Signed string is "<timestamp>.<raw body>", HMAC-SHA256 hex.
function verifyStripeSignature(rawBody, sigHeader, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (typeof rawBody !== "string" || !sigHeader || !secret) return false;
  let timestamp = null;
  const v1Sigs = [];
  for (const part of String(sigHeader).split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) v1Sigs.push(v);
  }
  if (!timestamp || !v1Sigs.length) return false;
  const tSeconds = Number(timestamp);
  if (!Number.isFinite(tSeconds)) return false;
  if (Math.abs(Math.floor(now / 1000) - tSeconds) > toleranceSeconds) return false; // stale/replayed
  const expected = crypto.createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return v1Sigs.some((sig) => {
    let sigBuf;
    try { sigBuf = Buffer.from(sig, "hex"); } catch { return false; }
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// Verifies + parses in one step so a caller can never see event JSON that
// didn't pass signature verification. Returns null on any failure (bad
// signature, stale timestamp, malformed JSON) — never throws.
function parseStripeEvent(rawBody, sigHeader, secret, opts) {
  if (!verifyStripeSignature(rawBody, sigHeader, secret, opts)) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

// current_period_end moved off the Subscription object onto each Subscription
// Item as of the 2025-03-31 ("basil") API version. This product has exactly
// one price/item, so read that first and fall back to the old top-level field
// for accounts still pinned to an older API version.
function subscriptionPeriodEndSeconds(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0];
  if (item && typeof item.current_period_end === "number") return item.current_period_end;
  if (sub && typeof sub.current_period_end === "number") return sub.current_period_end;
  return null;
}

// Finds the Twitch id a Stripe event is about. Checked in order:
//   1. metadata.twitch_id directly on the event's object (Subscription,
//      Invoice, or Customer — wherever the operator's Stripe config put it).
//   2. client_reference_id on a checkout.session.completed event (set by a
//      Payment Link's ?client_reference_id= query param, if that's what the
//      operator used instead of metadata).
//   3. An injected fetchCustomerMetadata(customerId) lookup, for events (like
//      most Invoice events) whose object doesn't carry its own metadata but
//      does carry a `customer` id whose Customer record might.
// Returns null if none of the above resolves — the event is then dropped
// (self-heals later: the next issuance attempt for that streamer, once their
// identity IS resolvable, reconciles against Stripe directly).
async function extractTwitchId(event, { fetchCustomerMetadata } = {}) {
  const obj = event && event.data && event.data.object;
  if (!obj) return null;
  if (obj.metadata && typeof obj.metadata.twitch_id === "string" && obj.metadata.twitch_id) {
    return obj.metadata.twitch_id;
  }
  if (event.type === "checkout.session.completed" &&
      typeof obj.client_reference_id === "string" && obj.client_reference_id) {
    return obj.client_reference_id;
  }
  const customerId = typeof obj.customer === "string" ? obj.customer : (obj.customer && obj.customer.id);
  if (customerId && fetchCustomerMetadata) {
    try {
      const twitchId = await fetchCustomerMetadata(customerId);
      if (twitchId) return twitchId;
    } catch {
      // fall through to null — reconciliation later is the safety net
    }
  }
  return null;
}

// ---- Entitlement cache ----
// One entry per Twitch id: { entitledUntilMs, source, everEntitled }.
// `source` is only for debugging/observability, never read for a decision.
// `everEntitled` records whether this id has ever been positively confirmed
// entitled (webhook or reconcile) — once true it stays true, even once the
// entry lapses past its grace window — so the Stripe-unreachable fallback
// in isEntitled() can tell "a known subscriber who's lapsed" apart from "a
// Twitch id we've only ever confirmed as NOT entitled".
function createEntitlementStore({ graceMs, now = Date.now, fetchCustomerMetadata, reconcile, writeSubscriptionMetadata } = {}) {
  if (!(graceMs > 0)) throw new Error("graceMs required");
  const cache = new Map();

  function extend(twitchId, untilMs, source) {
    const existing = cache.get(twitchId);
    const merged = Math.max(untilMs, existing ? existing.entitledUntilMs : -Infinity);
    cache.set(twitchId, { entitledUntilMs: merged, source, everEntitled: true });
  }

  // A lapse signal (payment failure, cancellation, non-entitling status)
  // starts the grace clock from now — it never *extends* entitlement, only
  // caps it, so a subscription that was good for another 25 days doesn't
  // stay "entitled" for 25 more days just because Stripe hasn't caught up.
  // If we've never seen this Twitch id before, a bare lapse signal still
  // grants a fresh grace window rather than nothing: a false ALLOW costs a
  // few days of service, a false DENY costs a customer's stream — see
  // README "Stripe entitlement" for why this asymmetry is deliberate.
  function lapse(twitchId, source) {
    const nowMs = now();
    const capped = nowMs + graceMs;
    const existing = cache.get(twitchId);
    const untilMs = existing ? Math.min(existing.entitledUntilMs, capped) : capped;
    cache.set(twitchId, { entitledUntilMs: untilMs, source, everEntitled: existing ? existing.everEntitled : false });
  }

  async function applyStripeEvent(event) {
    const twitchId = await extractTwitchId(event, { fetchCustomerMetadata });
    if (!twitchId) return; // can't attribute — dropped, reconciliation is the safety net
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        if (ENTITLING_STATUSES.has(sub.status)) {
          const periodEnd = subscriptionPeriodEndSeconds(sub);
          const baseMs = periodEnd ? periodEnd * 1000 : now();
          extend(twitchId, baseMs + graceMs, "webhook");
        } else {
          lapse(twitchId, "webhook"); // past_due, unpaid, incomplete, incomplete_expired, canceled
        }
        break;
      }
      case "customer.subscription.deleted":
      case "invoice.payment_failed":
        lapse(twitchId, "webhook");
        break;
      case "checkout.session.completed": {
        const session = event.data.object;
        // Only client_reference_id needs a durable write: if metadata.twitch_id
        // is already on the Session, the operator configured Stripe to carry it
        // onto the Subscription directly (see README "Identity linking"), so
        // there's nothing this module needs to persist itself.
        const viaClientReferenceId = typeof session.client_reference_id === "string" &&
          session.client_reference_id &&
          !(session.metadata && typeof session.metadata.twitch_id === "string" && session.metadata.twitch_id);
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription && session.subscription.id);
        if (viaClientReferenceId && subscriptionId && writeSubscriptionMetadata) {
          try {
            await writeSubscriptionMetadata(subscriptionId, twitchId);
          } catch {
            // Write failed — reconcile() has nothing new to find for this
            // subscriber. Same failure mode this module already had before
            // this write existed; no retry loop here, self-heals only if a
            // later Stripe event/action re-triggers this same code path.
          }
        }
        break;
      }
      default:
        // Unhandled event type — ignored, not an error (Stripe sends many
        // event types this relay doesn't care about).
        break;
    }
  }

  async function isEntitled(twitchId) {
    const nowMs = now();
    const cached = cache.get(twitchId);
    if (cached && cached.entitledUntilMs > nowMs) return true;
    if (!reconcile) return false;
    try {
      const result = await reconcile(twitchId);
      if (result && result.entitled) {
        const baseMs = result.periodEndSeconds ? result.periodEndSeconds * 1000 : nowMs;
        cache.set(twitchId, { entitledUntilMs: baseMs + graceMs, source: "reconcile", everEntitled: true });
        return true;
      }
      cache.set(twitchId, { entitledUntilMs: nowMs - 1, source: "reconcile", everEntitled: cached ? cached.everEntitled : false });
      return false;
    } catch {
      // Stripe unreachable. Degrade toward whatever we already knew rather
      // than guessing from nothing: if this Twitch id has ever been
      // positively confirmed entitled before (even if that's since lapsed
      // past its grace window), keep trusting that during the outage; a
      // Twitch id we've only ever confirmed as NOT entitled — or never seen
      // at all — gets denied, since there is nothing to trust. See README
      // "Stripe entitlement" for the tradeoff.
      return !!(cached && cached.everEntitled);
    }
  }

  return { applyStripeEvent, isEntitled };
}

// ---- Stripe API helpers ----
// All read-only (search/get) except createSubscriptionMetadataWriter below,
// this module's one deliberate, narrowly-scoped write.
function stripeAuthHeader(secretKey) {
  return "Basic " + Buffer.from(secretKey + ":").toString("base64");
}

// Looks up an active/trialing subscription by its metadata.twitch_id via
// Stripe's Search API — the mechanism that lets entitlement survive a
// restart/sleep with zero durable local state (see module header).
function createStripeReconciler({ secretKey, fetchImpl = fetch, apiBase = "https://api.stripe.com/v1" }) {
  if (!secretKey) throw new Error("secretKey required");
  return async function reconcile(twitchId) {
    const escaped = String(twitchId).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = `metadata['twitch_id']:'${escaped}'`;
    const url = apiBase + "/subscriptions/search?query=" + encodeURIComponent(query) + "&limit=1";
    const r = await fetchImpl(url, { headers: { Authorization: stripeAuthHeader(secretKey) } });
    if (!r.ok) throw new Error("stripe subscriptions/search failed: " + r.status);
    const j = await r.json();
    const sub = j.data && j.data[0];
    if (!sub) return { entitled: false, periodEndSeconds: null };
    return {
      entitled: ENTITLING_STATUSES.has(sub.status),
      periodEndSeconds: subscriptionPeriodEndSeconds(sub),
    };
  };
}

// The one write this module performs (see module header). Scoped as
// narrowly as the Stripe API allows: a single metadata key on a single
// existing Subscription, via the update-a-subscription endpoint — it cannot
// create, cancel, or touch billing/price/status on anything. Called only
// from the checkout.session.completed handler above, only when
// client_reference_id is the sole source of the identity link.
function createSubscriptionMetadataWriter({ secretKey, fetchImpl = fetch, apiBase = "https://api.stripe.com/v1" }) {
  if (!secretKey) throw new Error("secretKey required");
  return async function writeSubscriptionMetadata(subscriptionId, twitchId) {
    const url = apiBase + "/subscriptions/" + encodeURIComponent(subscriptionId);
    const body = "metadata[twitch_id]=" + encodeURIComponent(twitchId);
    const r = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: stripeAuthHeader(secretKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!r.ok) throw new Error("stripe subscription metadata write failed: " + r.status);
  };
}

// Fallback identity lookup for events whose object has no metadata of its
// own (mainly Invoice events) but does carry a `customer` id.
function createCustomerMetadataFetcher({ secretKey, fetchImpl = fetch, apiBase = "https://api.stripe.com/v1" }) {
  if (!secretKey) throw new Error("secretKey required");
  return async function fetchCustomerMetadata(customerId) {
    const url = apiBase + "/customers/" + encodeURIComponent(customerId);
    const r = await fetchImpl(url, { headers: { Authorization: stripeAuthHeader(secretKey) } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.metadata && typeof j.metadata.twitch_id === "string" && j.metadata.twitch_id) || null;
  };
}

module.exports = {
  verifyStripeSignature,
  parseStripeEvent,
  subscriptionPeriodEndSeconds,
  extractTwitchId,
  createEntitlementStore,
  createStripeReconciler,
  createCustomerMetadataFetcher,
  createSubscriptionMetadataWriter,
};
