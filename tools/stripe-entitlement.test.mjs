import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyStripeSignature,
  parseStripeEvent,
  subscriptionPeriodEndSeconds,
  extractTwitchId,
  createEntitlementStore,
} from "./stripe-entitlement.js";

// Builds a real Stripe-Signature header the same way Stripe does, so tests
// exercise the actual verification algorithm rather than a stand-in.
function signHeader(rawBody, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const sig = crypto.createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("verifyStripeSignature / parseStripeEvent", () => {
  const SECRET = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.created" });

  test("a correctly signed event verifies", () => {
    assert.equal(verifyStripeSignature(body, signHeader(body, SECRET), SECRET), true);
    assert.deepEqual(parseStripeEvent(body, signHeader(body, SECRET), SECRET), JSON.parse(body));
  });

  test("a forged event (wrong secret) is rejected", () => {
    const forged = signHeader(body, "wrong-secret");
    assert.equal(verifyStripeSignature(body, forged, SECRET), false);
    assert.equal(parseStripeEvent(body, forged, SECRET), null);
  });

  test("a tampered payload (body changed after signing) is rejected", () => {
    const header = signHeader(body, SECRET);
    const tamperedBody = JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted" });
    assert.equal(verifyStripeSignature(tamperedBody, header, SECRET), false);
    assert.equal(parseStripeEvent(tamperedBody, header, SECRET), null);
  });

  test("a stale timestamp outside tolerance is rejected (replay protection)", () => {
    const old = Math.floor(Date.now() / 1000) - 1000;
    const header = signHeader(body, SECRET, { timestamp: old });
    assert.equal(verifyStripeSignature(body, header, SECRET, { toleranceSeconds: 300 }), false);
  });

  test("a garbage header is rejected without throwing", () => {
    assert.equal(verifyStripeSignature(body, "not-a-real-header", SECRET), false);
    assert.equal(verifyStripeSignature(body, "", SECRET), false);
    assert.equal(verifyStripeSignature(body, signHeader(body, SECRET), ""), false);
  });
});

describe("subscriptionPeriodEndSeconds", () => {
  test("reads from the Subscription Item (current API shape)", () => {
    const sub = { items: { data: [{ current_period_end: 1700000000 }] } };
    assert.equal(subscriptionPeriodEndSeconds(sub), 1700000000);
  });

  test("falls back to the deprecated top-level field", () => {
    const sub = { current_period_end: 1600000000 };
    assert.equal(subscriptionPeriodEndSeconds(sub), 1600000000);
  });

  test("returns null when neither is present", () => {
    assert.equal(subscriptionPeriodEndSeconds({}), null);
  });
});

describe("extractTwitchId", () => {
  test("reads metadata.twitch_id directly off the event object", async () => {
    const event = { type: "customer.subscription.updated", data: { object: { metadata: { twitch_id: "abc" } } } };
    assert.equal(await extractTwitchId(event), "abc");
  });

  test("reads client_reference_id from checkout.session.completed", async () => {
    const event = { type: "checkout.session.completed", data: { object: { client_reference_id: "xyz" } } };
    assert.equal(await extractTwitchId(event), "xyz");
  });

  test("falls back to an injected customer-metadata lookup", async () => {
    const event = { type: "invoice.payment_failed", data: { object: { customer: "cus_123" } } };
    const twitchId = await extractTwitchId(event, {
      fetchCustomerMetadata: async (id) => (id === "cus_123" ? "linked-id" : null),
    });
    assert.equal(twitchId, "linked-id");
  });

  test("returns null when nothing resolves", async () => {
    const event = { type: "invoice.payment_failed", data: { object: {} } };
    assert.equal(await extractTwitchId(event), null);
  });

  test("a fetchCustomerMetadata rejection is swallowed, not thrown", async () => {
    const event = { type: "invoice.payment_failed", data: { object: { customer: "cus_x" } } };
    const twitchId = await extractTwitchId(event, {
      fetchCustomerMetadata: async () => { throw new Error("network down"); },
    });
    assert.equal(twitchId, null);
  });
});

describe("createEntitlementStore", () => {
  const GRACE_MS = 1000; // small for fast, deterministic tests

  function subEvent(type, twitchId, status, periodEndSeconds) {
    return {
      type,
      data: { object: { metadata: { twitch_id: twitchId }, status, items: { data: [{ current_period_end: periodEndSeconds }] } } },
    };
  }

  test("an entitled user (active subscription) is granted", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => clock });
    await store.applyStripeEvent(subEvent("customer.subscription.created", "streamer-a", "active", Math.floor(clock / 1000) + 3600));
    assert.equal(await store.isEntitled("streamer-a"), true);
  });

  test("an unentitled user (never seen, no reconcile configured) is refused", async () => {
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => 1_000_000_000_000 });
    assert.equal(await store.isEntitled("nobody"), false);
  });

  test("a non-entitling status update (e.g. past_due) does not grant access", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => clock });
    await store.applyStripeEvent(subEvent("customer.subscription.updated", "streamer-b", "past_due", null));
    // past_due still opens a grace window from "now" (lapse), just not a full renewal.
    assert.equal(await store.isEntitled("streamer-b"), true);
    clock += GRACE_MS + 1;
    assert.equal(await store.isEntitled("streamer-b"), false);
  });

  test("lapse within the grace period keeps access; beyond it, access is refused", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => clock });
    await store.applyStripeEvent(subEvent("customer.subscription.created", "streamer-c", "active", Math.floor(clock / 1000) + 3600));
    await store.applyStripeEvent({ type: "invoice.payment_failed", data: { object: { metadata: { twitch_id: "streamer-c" } } } });

    assert.equal(await store.isEntitled("streamer-c"), true, "still within grace immediately after lapse");
    clock += GRACE_MS - 1;
    assert.equal(await store.isEntitled("streamer-c"), true, "still within grace just before it ends");
    clock += 2;
    assert.equal(await store.isEntitled("streamer-c"), false, "refused once past the grace window");
  });

  test("a lapse never extends entitlement beyond what an active subscription already had", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => clock });
    // Active for a long time yet (period end far in the future)...
    await store.applyStripeEvent(subEvent("customer.subscription.created", "streamer-d", "active", Math.floor(clock / 1000) + 1_000_000));
    // ...then cancelled right now. Entitlement should cap at now+grace, not run to the old period end.
    await store.applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { metadata: { twitch_id: "streamer-d" } } } });
    clock += GRACE_MS + 1;
    assert.equal(await store.isEntitled("streamer-d"), false);
  });

  test("subscription.deleted for a Twitch id never seen before still opens a fresh grace window (favors false-allow)", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => clock });
    await store.applyStripeEvent({ type: "customer.subscription.deleted", data: { object: { metadata: { twitch_id: "streamer-e" } } } });
    assert.equal(await store.isEntitled("streamer-e"), true);
    clock += GRACE_MS + 1;
    assert.equal(await store.isEntitled("streamer-e"), false);
  });

  test("a cache miss reconciles against Stripe directly (the restart/sleep-safety path)", async () => {
    let clock = 1_000_000_000_000;
    let reconcileCalls = 0;
    const store = createEntitlementStore({
      graceMs: GRACE_MS,
      now: () => clock,
      reconcile: async (twitchId) => {
        reconcileCalls++;
        assert.equal(twitchId, "streamer-f");
        return { entitled: true, periodEndSeconds: Math.floor(clock / 1000) + 3600 };
      },
    });
    assert.equal(await store.isEntitled("streamer-f"), true);
    assert.equal(reconcileCalls, 1);
    // Second call within the reconciled window shouldn't need Stripe again.
    assert.equal(await store.isEntitled("streamer-f"), true);
    assert.equal(reconcileCalls, 1);
  });

  test("a cache miss that reconciles to 'not entitled' is refused", async () => {
    const store = createEntitlementStore({
      graceMs: GRACE_MS,
      now: () => 1_000_000_000_000,
      reconcile: async () => ({ entitled: false, periodEndSeconds: null }),
    });
    assert.equal(await store.isEntitled("streamer-g"), false);
  });

  test("Stripe unreachable during reconciliation: falls back to prior cached knowledge if any exists", async () => {
    let clock = 1_000_000_000_000;
    const store = createEntitlementStore({
      graceMs: GRACE_MS,
      now: () => clock,
      reconcile: async () => { throw new Error("stripe unreachable"); },
    });
    await store.applyStripeEvent(subEvent("customer.subscription.created", "streamer-h", "active", Math.floor(clock / 1000) + 3600));
    clock += GRACE_MS + 3600 * 1000 + 1; // well past cached entitlement, forcing a reconcile attempt
    assert.equal(await store.isEntitled("streamer-h"), true, "prior cached knowledge should be trusted during an outage");
  });

  test("Stripe unreachable during reconciliation, with no prior knowledge at all: refused, not guessed", async () => {
    const store = createEntitlementStore({
      graceMs: GRACE_MS,
      now: () => 1_000_000_000_000,
      reconcile: async () => { throw new Error("stripe unreachable"); },
    });
    assert.equal(await store.isEntitled("never-seen"), false);
  });

  test("Stripe unreachable during reconciliation, with a prior confirmed-NOT-entitled cache entry: still refused", async () => {
    let unreachable = false;
    const store = createEntitlementStore({
      graceMs: GRACE_MS,
      now: () => 1_000_000_000_000,
      reconcile: async () => {
        if (unreachable) throw new Error("stripe unreachable");
        return { entitled: false, periodEndSeconds: null };
      },
    });
    assert.equal(await store.isEntitled("never-a-subscriber"), false, "first reconcile confirms not entitled");
    unreachable = true;
    assert.equal(
      await store.isEntitled("never-a-subscriber"),
      false,
      "a prior confirmed-negative determination must not be trusted as if it were positive"
    );
  });

  test("an unresolvable event (no twitch id anywhere) is dropped without throwing", async () => {
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => 1_000_000_000_000 });
    await store.applyStripeEvent({ type: "customer.subscription.created", data: { object: { status: "active" } } });
    assert.equal(await store.isEntitled(undefined), false);
  });

  test("an unhandled event type is ignored", async () => {
    const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => 1_000_000_000_000 });
    await store.applyStripeEvent({ type: "customer.created", data: { object: { metadata: { twitch_id: "streamer-i" } } } });
    assert.equal(await store.isEntitled("streamer-i"), false);
  });

  function checkoutEvent({ clientReferenceId, sessionMetadataTwitchId, subscription }) {
    return {
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: clientReferenceId,
          metadata: sessionMetadataTwitchId ? { twitch_id: sessionMetadataTwitchId } : undefined,
          subscription,
        },
      },
    };
  }

  describe("checkout.session.completed identity write", () => {
    test("client_reference_id triggers a scoped write of metadata.twitch_id onto the Subscription", async () => {
      const writes = [];
      const store = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => 1_000_000_000_000,
        writeSubscriptionMetadata: async (subscriptionId, twitchId) => { writes.push({ subscriptionId, twitchId }); },
      });
      await store.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-j", subscription: "sub_123" }));
      assert.deepEqual(writes, [{ subscriptionId: "sub_123", twitchId: "streamer-j" }]);
    });

    test("no write when the session already carries metadata.twitch_id directly (operator configured the template mechanism)", async () => {
      const writes = [];
      const store = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => 1_000_000_000_000,
        writeSubscriptionMetadata: async (...args) => { writes.push(args); },
      });
      await store.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-k", sessionMetadataTwitchId: "streamer-k", subscription: "sub_456" }));
      assert.deepEqual(writes, []);
    });

    test("no write when the session has no subscription id (e.g. one-time payment, not subscription mode)", async () => {
      const writes = [];
      const store = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => 1_000_000_000_000,
        writeSubscriptionMetadata: async (...args) => { writes.push(args); },
      });
      await store.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-l", subscription: undefined }));
      assert.deepEqual(writes, []);
    });

    test("no write when no writeSubscriptionMetadata dependency is configured", async () => {
      const store = createEntitlementStore({ graceMs: GRACE_MS, now: () => 1_000_000_000_000 });
      // Must not throw even though writeSubscriptionMetadata is undefined.
      await store.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-m", subscription: "sub_789" }));
    });

    test("a write failure is swallowed, not thrown, and does not itself grant entitlement", async () => {
      const store = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => 1_000_000_000_000,
        writeSubscriptionMetadata: async () => { throw new Error("stripe unreachable"); },
      });
      await store.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-n", subscription: "sub_000" }));
      assert.equal(await store.isEntitled("streamer-n"), false);
    });

    test("the write is scoped to exactly one subscription id and one twitch id — never induced to write anything else", async () => {
      const calls = [];
      const store = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => 1_000_000_000_000,
        writeSubscriptionMetadata: async (subscriptionId, twitchId) => { calls.push({ subscriptionId, twitchId }); },
      });
      // A malicious/odd event object can't smuggle extra fields into the write call —
      // writeSubscriptionMetadata only ever receives the two positional args below.
      await store.applyStripeEvent({
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "streamer-o",
            subscription: "sub_o",
            customer: "cus_should_be_ignored",
            amount_total: 999999,
          },
        },
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(Object.keys(calls[0]).sort(), ["subscriptionId", "twitchId"]);
      assert.deepEqual(calls[0], { subscriptionId: "sub_o", twitchId: "streamer-o" });
    });
  });

  describe("restart safety: identity link written at checkout survives a full process restart", () => {
    test("subscribes, discards ALL in-memory state (simulating a Render sleep/restart), and still resolves entitled from Stripe alone", async () => {
      // Simulates Stripe's own durable state — nothing this test controls
      // directly, standing in for what createSubscriptionMetadataWriter would
      // have actually written via the real Stripe API.
      const stripeSubscriptions = new Map();
      stripeSubscriptions.set("sub_p", { status: "active", periodEndSeconds: 1_000_003_600, metadataTwitchId: null });

      let clock = 1_000_000_000_000;
      const preRestartStore = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => clock,
        writeSubscriptionMetadata: async (subscriptionId, twitchId) => {
          const sub = stripeSubscriptions.get(subscriptionId);
          sub.metadataTwitchId = twitchId;
        },
      });

      // Checkout completes: client_reference_id resolves the id, and the
      // write lands on Stripe's (simulated) subscription record.
      await preRestartStore.applyStripeEvent(checkoutEvent({ clientReferenceId: "streamer-p", subscription: "sub_p" }));
      assert.equal(stripeSubscriptions.get("sub_p").metadataTwitchId, "streamer-p", "identity link must be durably on the Subscription before restart");

      // --- restart: preRestartStore and its in-memory cache are discarded. ---
      // A brand-new store is built, with only reconcile() wired up (as
      // server.js does on boot) — no cache entries carried over.
      const postRestartStore = createEntitlementStore({
        graceMs: GRACE_MS,
        now: () => clock,
        reconcile: async (twitchId) => {
          const sub = [...stripeSubscriptions.values()].find((s) => s.metadataTwitchId === twitchId);
          if (!sub) return { entitled: false, periodEndSeconds: null };
          return { entitled: sub.status === "active" || sub.status === "trialing", periodEndSeconds: sub.periodEndSeconds };
        },
      });

      assert.equal(await postRestartStore.isEntitled("streamer-p"), true, "already-subscribed user must still resolve as entitled after a full restart");
    });
  });
});
