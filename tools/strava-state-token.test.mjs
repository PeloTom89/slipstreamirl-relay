import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signStravaState, verifyStravaState } from "./strava-state-token.js";

test("a token signed for a twitchId verifies and yields that twitchId", () => {
  const token = signStravaState("12345", "s3cret");
  const claims = verifyStravaState(token, "s3cret");
  assert.equal(claims.twitchId, "12345");
});

test("verification fails with the wrong secret", () => {
  const token = signStravaState("12345", "s3cret");
  assert.equal(verifyStravaState(token, "wrong-secret"), null);
});

test("a tampered payload fails signature verification", () => {
  const token = signStravaState("12345", "s3cret");
  const [header, , sig] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ twitchId: "99999", iat: 0, exp: 9999999999 })).toString("base64url");
  const tampered = [header, tamperedPayload, sig].join(".");
  assert.equal(verifyStravaState(tampered, "s3cret"), null);
});

test("an expired token is rejected", () => {
  const now = 1_700_000_000_000;
  const token = signStravaState("12345", "s3cret", { ttlSeconds: 60, now });
  const claims = verifyStravaState(token, "s3cret", { now: now + 61_000 });
  assert.equal(claims, null);
});

test("a token still within its ttl is accepted", () => {
  const now = 1_700_000_000_000;
  const token = signStravaState("12345", "s3cret", { ttlSeconds: 60, now });
  const claims = verifyStravaState(token, "s3cret", { now: now + 30_000 });
  assert.equal(claims.twitchId, "12345");
});

test("malformed tokens are rejected without throwing", () => {
  assert.equal(verifyStravaState("not-a-jwt", "s3cret"), null);
  assert.equal(verifyStravaState("a.b", "s3cret"), null);
  assert.equal(verifyStravaState("", "s3cret"), null);
  assert.equal(verifyStravaState(null, "s3cret"), null);
});

test("signing requires a twitchId and a secret", () => {
  assert.throws(() => signStravaState("", "s3cret"));
  assert.throws(() => signStravaState("12345", ""));
});

test("a channel-token-shaped payload (no twitchId claim) is rejected", () => {
  // Cross-token-kind replay: a channel-token payload has {channel, iat, exp},
  // not {twitchId, iat, exp} — must never verify as Strava state even though
  // both modules use the same HS256 shape and could share a secret.
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ channel: "12345", iat: 0, exp: 9999999999 })).toString("base64url");
  const signingInput = header + "." + payload;
  const sig = crypto.createHmac("sha256", "s3cret").update(signingInput).digest("base64url");
  assert.equal(verifyStravaState(signingInput + "." + sig, "s3cret"), null);
});
