// tools/relay-entitlement.test.mjs — integration tests for the Stripe
// entitlement path (POST /stripe-webhook, POST /channel-token) against a real
// spawned server.js, with local HTTP stubs standing in for Twitch Helix and
// the Stripe API (TWITCH_HELIX_BASE / STRIPE_API_BASE overrides — test-only,
// see server.js). No live Stripe or Twitch credentials are used anywhere
// here; signatures are computed with the same HMAC scheme Stripe documents,
// against fixtures shaped like Stripe's real event/object shapes.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { startServer } from "./spawn-relay.mjs";

function stripeSignatureHeader(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function startStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

describe("Stripe entitlement (MULTI_TENANT + Stripe configured)", () => {
  const JWT_SECRET = "test-jwt-secret";
  const WEBHOOK_SECRET = "whsec_test";
  const STRIPE_KEY = "sk_test_fake";
  const GRACE_SECONDS = 1; // short, so "beyond the grace period" is fast to test

  let twitchStub, stripeStub, server;
  let twitchIdToReturn = "streamer-1";
  let stripeSearchResponse = { data: [] };
  let stripeCustomerResponse = { metadata: {} };

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: twitchIdToReturn }] }));
    });
    stripeStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/subscriptions/search")) res.end(JSON.stringify(stripeSearchResponse));
      else res.end(JSON.stringify(stripeCustomerResponse));
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ENTITLEMENT_GRACE_SECONDS: String(GRACE_SECONDS),
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      STRIPE_API_BASE: `http://127.0.0.1:${stripeStub.address().port}`,
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stripeStub.close(r));
  });

  async function postWebhook(eventBody, { signature } = {}) {
    const raw = JSON.stringify(eventBody);
    const sig = signature !== undefined ? signature : stripeSignatureHeader(raw, WEBHOOK_SECRET);
    return fetch(`${server.baseHttp}/stripe-webhook`, {
      method: "POST",
      headers: { "Stripe-Signature": sig },
      body: raw,
    });
  }

  async function requestToken(twitchAccessToken = "fake-user-access-token") {
    return fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken }),
    });
  }

  test("a forged webhook signature is rejected (security-critical case)", async () => {
    const raw = JSON.stringify({ id: "evt_forged", type: "customer.subscription.created", data: { object: {} } });
    const res = await postWebhook(JSON.parse(raw), { signature: "t=1,v1=" + "0".repeat(64) });
    assert.equal(res.status, 400);
  });

  test("a webhook signed with the wrong secret is rejected", async () => {
    const raw = JSON.stringify({ id: "evt_wrong_secret", type: "customer.subscription.created", data: { object: {} } });
    const res = await postWebhook(JSON.parse(raw), { signature: stripeSignatureHeader(raw, "wrong-secret") });
    assert.equal(res.status, 400);
  });

  test("an unentitled user is refused a channel token", async () => {
    twitchIdToReturn = "streamer-unentitled";
    const res = await requestToken();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "not entitled");
  });

  test("an entitled user (valid subscription webhook) receives a channel token", async () => {
    twitchIdToReturn = "streamer-entitled";
    const periodEnd = Math.floor(Date.now() / 1000) + 3600;
    const webhookRes = await postWebhook({
      id: "evt_active",
      type: "customer.subscription.created",
      data: { object: { status: "active", metadata: { twitch_id: "streamer-entitled" }, items: { data: [{ current_period_end: periodEnd }] } } },
    });
    assert.equal(webhookRes.status, 200);

    const tokenRes = await requestToken();
    assert.equal(tokenRes.status, 200);
    const body = await tokenRes.json();
    assert.equal(body.channel, "streamer-entitled");
    assert.ok(body.token, "expected a signed channel token in the response");
  });

  test("identity linking: an invoice event with no direct metadata falls back to the Customer's metadata.twitch_id", async () => {
    twitchIdToReturn = "streamer-via-customer";
    stripeCustomerResponse = { metadata: { twitch_id: "streamer-via-customer" } };
    // invoice.payment_failed alone (no prior subscription.created) still grants
    // a grace window per the entitlement store's design — see stripe-entitlement.test.mjs.
    const res = await postWebhook({
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_via_customer_lookup" } }, // no .metadata of its own
    });
    assert.equal(res.status, 200);

    const tokenRes = await requestToken();
    assert.equal(tokenRes.status, 200);
    assert.equal((await tokenRes.json()).channel, "streamer-via-customer");
  });

  test("a lapse behaves as designed: token issuance succeeds within the grace period, then is refused beyond it", async () => {
    twitchIdToReturn = "streamer-lapsing";
    stripeCustomerResponse = { metadata: {} }; // don't let the customer-fallback re-entitle this one
    stripeSearchResponse = { data: [] }; // and reconciliation must also say "not active"

    await postWebhook({
      id: "evt_lapse_active",
      type: "customer.subscription.created",
      data: { object: { status: "active", metadata: { twitch_id: "streamer-lapsing" }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } } },
    });
    await postWebhook({
      id: "evt_lapse_failed",
      type: "invoice.payment_failed",
      data: { object: { metadata: { twitch_id: "streamer-lapsing" } } },
    });

    const withinGrace = await requestToken();
    assert.equal(withinGrace.status, 200, "should still be entitled inside the grace window");

    await new Promise((r) => setTimeout(r, (GRACE_SECONDS * 1000) + 300));

    const beyondGrace = await requestToken();
    assert.equal(beyondGrace.status, 403, "should be refused once past the grace window");
  });

  test("a Twitch id never seen by this process reconciles directly against Stripe (restart/sleep-safety path)", async () => {
    twitchIdToReturn = "streamer-cold-start";
    stripeSearchResponse = { data: [{ status: "active", items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } } ] };

    // No webhook was ever sent for this Twitch id — simulates a fresh process
    // (post Render sleep/restart) whose in-memory cache never learned about it.
    const res = await requestToken();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).channel, "streamer-cold-start");
  });
});

describe("checkout.session.completed identity write, end-to-end (real HTTP to a stub Stripe)", () => {
  const JWT_SECRET = "test-jwt-secret";
  const WEBHOOK_SECRET = "whsec_test";
  const STRIPE_KEY = "sk_test_fake";
  const GRACE_SECONDS = 120;

  let twitchStub, stripeStub, server;
  let twitchIdToReturn = "streamer-checkout";
  // Models Stripe's own durable Subscription store — what the relay's one
  // write (createSubscriptionMetadataWriter) actually mutates, and what
  // reconcile()'s search reads back. Seeded as an active subscription with no
  // metadata yet, the way it looks the instant Checkout finishes but before
  // the identity link has been written anywhere.
  let subscriptions;
  const writeRequests = [];

  before(async () => {
    subscriptions = new Map();
    subscriptions.set("sub_checkout_1", { status: "active", periodEndSeconds: Math.floor(Date.now() / 1000) + 3600, metadata: {} });

    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: twitchIdToReturn }] }));
    });
    stripeStub = await startStub((req, res) => {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/subscriptions/search") {
        const query = url.searchParams.get("query") || "";
        const m = query.match(/metadata\['twitch_id'\]:'([^']*)'/);
        const twitchId = m && m[1];
        const found = [...subscriptions.values()].find((s) => s.metadata.twitch_id === twitchId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: found ? [{ status: found.status, items: { data: [{ current_period_end: found.periodEndSeconds }] } }] : [] }));
        return;
      }
      const subMatch = url.pathname.match(/^\/subscriptions\/([^/]+)$/);
      if (req.method === "POST" && subMatch) {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          writeRequests.push({ subscriptionId: subMatch[1], body });
          const params = new URLSearchParams(body);
          const twitchId = params.get("metadata[twitch_id]");
          const sub = subscriptions.get(subMatch[1]);
          if (sub && twitchId) sub.metadata.twitch_id = twitchId;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sub || {}));
        });
        return;
      }
      res.writeHead(404); res.end("not found in stub");
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ENTITLEMENT_GRACE_SECONDS: String(GRACE_SECONDS),
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      STRIPE_API_BASE: `http://127.0.0.1:${stripeStub.address().port}`,
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stripeStub.close(r));
  });

  test("client_reference_id on checkout.session.completed writes metadata.twitch_id onto the named Subscription, and only that", async () => {
    const raw = JSON.stringify({
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "streamer-checkout", subscription: "sub_checkout_1", customer: "cus_ignored", amount_total: 4200 } },
    });
    const res = await fetch(`${server.baseHttp}/stripe-webhook`, {
      method: "POST",
      headers: { "Stripe-Signature": stripeSignatureHeader(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    assert.equal(res.status, 200);

    assert.equal(writeRequests.length, 1, "exactly one write request reached Stripe");
    assert.equal(writeRequests[0].subscriptionId, "sub_checkout_1");
    assert.equal(writeRequests[0].body, "metadata[twitch_id]=streamer-checkout", "the write body carries only the twitch_id metadata key — nothing else");
    assert.equal(subscriptions.get("sub_checkout_1").metadata.twitch_id, "streamer-checkout");
  });

  test("restart safety: with no cache (no subscription.created webhook ever sent), a fresh token request resolves entitled purely via Stripe search against the written metadata", async () => {
    // No customer.subscription.created/updated webhook is sent in this test —
    // simulating that the relay process restarted (or simply never received
    // one yet) between checkout completing and the user opening the app. The
    // only way this can resolve is the write from the previous test having
    // landed durably in Stripe, found here by reconcile()'s search call.
    const res = await fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-user-access-token" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channel, "streamer-checkout");
    assert.ok(body.token);
  });

  test("a checkout session with metadata.twitch_id already present (template-configured Payment Link) triggers no write", async () => {
    subscriptions.set("sub_checkout_2", { status: "active", periodEndSeconds: Math.floor(Date.now() / 1000) + 3600, metadata: {} });
    const before = writeRequests.length;
    const raw = JSON.stringify({
      id: "evt_checkout_template",
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "streamer-templated", metadata: { twitch_id: "streamer-templated" }, subscription: "sub_checkout_2" } },
    });
    const res = await fetch(`${server.baseHttp}/stripe-webhook`, {
      method: "POST",
      headers: { "Stripe-Signature": stripeSignatureHeader(raw, WEBHOOK_SECRET) },
      body: raw,
    });
    assert.equal(res.status, 200);
    assert.equal(writeRequests.length, before, "no additional write when the template mechanism already carried metadata onto the Session");
  });
});

describe("beta allowlist (BETA_ALLOWLIST_TWITCH_IDS)", () => {
  const JWT_SECRET = "test-jwt-secret";
  const WEBHOOK_SECRET = "whsec_test";
  const STRIPE_KEY = "sk_test_fake";
  const GRACE_SECONDS = 120;

  let twitchStub, stripeStub, server;
  let twitchIdToReturn = "streamer-allowlist-1";

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // A sentinel "invalid" token means "no identity resolves" — used to
      // prove the allowlist can't bypass identity verification.
      const authHeader = req.headers["authorization"] || "";
      if (authHeader === "Bearer invalid-token") { res.end(JSON.stringify({ data: [] })); return; }
      res.end(JSON.stringify({ data: [{ id: twitchIdToReturn }] }));
    });
    stripeStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // No active subscription anywhere — every id here is unentitled by Stripe alone.
      if (req.url.startsWith("/subscriptions/search")) res.end(JSON.stringify({ data: [] }));
      else res.end(JSON.stringify({ metadata: {} }));
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ENTITLEMENT_GRACE_SECONDS: String(GRACE_SECONDS),
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      STRIPE_API_BASE: `http://127.0.0.1:${stripeStub.address().port}`,
      BETA_ALLOWLIST_TWITCH_IDS: "streamer-allowlist-1, streamer-allowlist-2,, ,streamer-allowlist-3",
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stripeStub.close(r));
  });

  async function requestToken(twitchAccessToken = "fake-user-access-token") {
    return fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken }),
    });
  }

  test("an allowlisted id with a verifiable Twitch identity is granted a token", async () => {
    twitchIdToReturn = "streamer-allowlist-1";
    const res = await requestToken();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.channel, "streamer-allowlist-1");
    assert.ok(body.token);
  });

  test("stray commas/whitespace in the allowlist parse to the trimmed ids, not blank entries", async () => {
    twitchIdToReturn = "streamer-allowlist-3";
    const res = await requestToken();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).channel, "streamer-allowlist-3");
  });

  test("a non-allowlisted, non-subscribed id is still refused (403)", async () => {
    twitchIdToReturn = "streamer-not-allowlisted";
    const res = await requestToken();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "not entitled");
  });

  test("an allowlisted id WITHOUT a verifiable Twitch identity is still rejected — no identity bypass", async () => {
    // The stub Helix server treats this sentinel token as "no identity" —
    // being allowlisted-by-id never substitutes for a verified Twitch token.
    const res = await requestToken("invalid-token");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "could not verify Twitch identity");
  });

  test("the root status line reports the allowlisted-id count", async () => {
    const res = await fetch(`${server.baseHttp}/`);
    const text = await res.text();
    assert.match(text, /3 beta allowlisted/);
  });
});

describe("beta allowlist is empty by default — grants nobody", () => {
  const JWT_SECRET = "test-jwt-secret";
  const WEBHOOK_SECRET = "whsec_test";
  const STRIPE_KEY = "sk_test_fake";

  let twitchStub, stripeStub, server;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "streamer-would-be-allowlisted" }] }));
    });
    stripeStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/subscriptions/search")) res.end(JSON.stringify({ data: [] }));
      else res.end(JSON.stringify({ metadata: {} }));
    });
    // BETA_ALLOWLIST_TWITCH_IDS deliberately a stray-comma/whitespace string,
    // never a real id, and also tested absent entirely below.
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      STRIPE_API_BASE: `http://127.0.0.1:${stripeStub.address().port}`,
      BETA_ALLOWLIST_TWITCH_IDS: " , ,",
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stripeStub.close(r));
  });

  test("an allowlist of only stray commas/whitespace grants nobody, including an id that would match a blank entry", async () => {
    const res = await fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-user-access-token" }),
    });
    assert.equal(res.status, 403);
  });

  test("the root status line omits the allowlist note entirely when nobody is allowlisted", async () => {
    const res = await fetch(`${server.baseHttp}/`);
    const text = await res.text();
    assert.doesNotMatch(text, /beta allowlisted/);
  });
});

describe("beta allowlist absent entirely (existing Stripe entitlement test suite is unaffected)", () => {
  const JWT_SECRET = "test-jwt-secret";
  const WEBHOOK_SECRET = "whsec_test";
  const STRIPE_KEY = "sk_test_fake";

  let twitchStub, stripeStub, server;

  before(async () => {
    twitchStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "streamer-paying" }] }));
    });
    stripeStub = await startStub((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const periodEnd = Math.floor(Date.now() / 1000) + 3600;
      if (req.url.startsWith("/subscriptions/search")) {
        res.end(JSON.stringify({ data: [{ status: "active", items: { data: [{ current_period_end: periodEnd }] } }] }));
      } else {
        res.end(JSON.stringify({ metadata: {} }));
      }
    });
    server = await startServer({
      MULTI_TENANT: "1",
      RELAY_JWT_SECRET: JWT_SECRET,
      STRIPE_SECRET_KEY: STRIPE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TWITCH_HELIX_BASE: `http://127.0.0.1:${twitchStub.address().port}`,
      STRIPE_API_BASE: `http://127.0.0.1:${stripeStub.address().port}`,
      // BETA_ALLOWLIST_TWITCH_IDS intentionally absent.
    });
  });

  after(async () => {
    await server.stop();
    await new Promise((r) => twitchStub.close(r));
    await new Promise((r) => stripeStub.close(r));
  });

  test("a paying subscriber is unaffected by the (absent) allowlist", async () => {
    const res = await fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "fake-user-access-token" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).channel, "streamer-paying");
  });
});

describe("single-tenant mode is unaffected by entitlement config", () => {
  let server;

  before(async () => {
    // Stripe vars ARE set here, deliberately, to prove they're inert without
    // MULTI_TENANT — the free/BYO tier must never gain a phone-home dependency.
    server = await startServer({
      RELAY_TOKEN: "legacy-token",
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
  });
  after(async () => { await server.stop(); });

  test("/channel-token does not exist in single-tenant mode", async () => {
    const res = await fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "whatever" }),
    });
    assert.equal(res.status, 404);
  });

  test("/stripe-webhook does not exist in single-tenant mode", async () => {
    const res = await fetch(`${server.baseHttp}/stripe-webhook`, {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=" + "0".repeat(64) },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });

  test("the free-tier push/health contract is unchanged", async () => {
    const ok = await fetch(`${server.baseHttp}/push?token=legacy-token`, {
      method: "POST",
      body: JSON.stringify({ lat: 1, lng: 2 }),
    });
    assert.equal(ok.status, 200);
  });
});

describe("multi-tenant mode without Stripe configured is unaffected (manual minting still works)", () => {
  let server;

  before(async () => {
    server = await startServer({ MULTI_TENANT: "1", RELAY_JWT_SECRET: "test-secret-no-stripe" });
  });
  after(async () => { await server.stop(); });

  test("/channel-token reports entitlement as not configured, rather than issuing or crashing", async () => {
    const res = await fetch(`${server.baseHttp}/channel-token`, {
      method: "POST",
      body: JSON.stringify({ twitchAccessToken: "whatever" }),
    });
    assert.equal(res.status, 503);
  });

  test("/stripe-webhook reports not configured rather than crashing", async () => {
    const res = await fetch(`${server.baseHttp}/stripe-webhook`, {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=" + "0".repeat(64) },
      body: "{}",
    });
    assert.equal(res.status, 503);
  });
});
