import { test } from "node:test";
import assert from "node:assert/strict";
import { signChannelToken, verifyChannelToken } from "./channel-token.js";

test("a token signed for a channel verifies and yields that channel", () => {
  const token = signChannelToken("12345", "s3cret");
  const claims = verifyChannelToken(token, "s3cret");
  assert.equal(claims.channel, "12345");
});

test("verification fails with the wrong secret", () => {
  const token = signChannelToken("12345", "s3cret");
  assert.equal(verifyChannelToken(token, "wrong-secret"), null);
});

test("a tampered payload fails signature verification", () => {
  const token = signChannelToken("12345", "s3cret");
  const [header, payload, sig] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({ channel: "99999", iat: 0, exp: 9999999999 })).toString("base64url");
  const tampered = [header, tamperedPayload, sig].join(".");
  assert.equal(verifyChannelToken(tampered, "s3cret"), null);
});

test("an expired token is rejected", () => {
  const now = 1_700_000_000_000;
  const token = signChannelToken("12345", "s3cret", { ttlSeconds: 60, now });
  const claims = verifyChannelToken(token, "s3cret", { now: now + 61_000 });
  assert.equal(claims, null);
});

test("a token still within its ttl is accepted", () => {
  const now = 1_700_000_000_000;
  const token = signChannelToken("12345", "s3cret", { ttlSeconds: 60, now });
  const claims = verifyChannelToken(token, "s3cret", { now: now + 30_000 });
  assert.equal(claims.channel, "12345");
});

test("malformed tokens are rejected without throwing", () => {
  assert.equal(verifyChannelToken("not-a-jwt", "s3cret"), null);
  assert.equal(verifyChannelToken("a.b", "s3cret"), null);
  assert.equal(verifyChannelToken("", "s3cret"), null);
  assert.equal(verifyChannelToken(null, "s3cret"), null);
});

test("signing requires a channel and a secret", () => {
  assert.throws(() => signChannelToken("", "s3cret"));
  assert.throws(() => signChannelToken("12345", ""));
});

test("two different channels get non-interchangeable tokens", () => {
  const tokenA = signChannelToken("channel-a", "s3cret");
  const claimsA = verifyChannelToken(tokenA, "s3cret");
  assert.equal(claimsA.channel, "channel-a");
  assert.notEqual(claimsA.channel, "channel-b");
});
