// tools/channel-token.js — minimal HS256 JWT sign/verify for multi-tenant
// per-channel push auth (server.js's MULTI_TENANT mode).
//
// No jsonwebtoken dependency: Node's built-in crypto covers HMAC-SHA256, and
// this project deliberately stays a small handful of files with no framework
// dependencies beyond `ws`. CommonJS (not the tools/*.mjs convention used by
// road-names.mjs) because server.js is CommonJS and needs to `require()` this
// synchronously at request time — see AGENTS.md.
//
// Claims are intentionally minimal ({channel, iat, exp}) so a later
// expiry-based entitlement check can key off `exp` without any token-format
// rework — see the multi-tenant design doc referenced from ROADMAP.md.

const crypto = require("crypto");

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signChannelToken(channel, secret, { ttlSeconds = 86400, now = Date.now() } = {}) {
  if (!channel || typeof channel !== "string") throw new Error("channel required");
  if (!secret) throw new Error("secret required");
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ channel, iat, exp: iat + Math.max(1, Math.floor(ttlSeconds)) }));
  const signingInput = header + "." + payload;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return signingInput + "." + sig;
}

function verifyChannelToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string" || !token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!claims || typeof claims.channel !== "string" || !claims.channel) return null;
  if (typeof claims.exp === "number" && Math.floor(now / 1000) >= claims.exp) return null;
  return claims;
}

module.exports = { signChannelToken, verifyChannelToken };
