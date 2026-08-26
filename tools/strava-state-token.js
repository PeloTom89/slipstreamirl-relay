// tools/strava-state-token.js — signs/verifies the short-lived `state` query
// param carried through the Strava OAuth round trip (GET /strava-authorize ->
// Strava's consent screen -> GET /strava-callback), binding the link attempt
// to the Twitch id verifyTwitchUser() resolved when the flow started. The
// callback must never trust a Twitch id from anywhere else — this token is
// the only thing that stops one user's linked Strava landing on another
// user's account.
//
// Same HS256 sign/verify shape as tools/channel-token.js ({claim, iat, exp},
// Node's built-in crypto, no jsonwebtoken dependency) but a separate module
// rather than a generalized channel-token.js: the claim here is `twitchId`,
// not `channel`, and the two token kinds must never be interchangeable — a
// channel push token replayed as Strava link state, or vice versa, must fail
// to verify (different claim shape, same secret notwithstanding).
// CommonJS for the same server.js-require()s-this-synchronously reason as
// channel-token.js — see AGENTS.md.

const crypto = require("crypto");

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signStravaState(twitchId, secret, { ttlSeconds = 600, now = Date.now() } = {}) {
  if (!twitchId || typeof twitchId !== "string") throw new Error("twitchId required");
  if (!secret) throw new Error("secret required");
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ twitchId, iat, exp: iat + Math.max(1, Math.floor(ttlSeconds)) }));
  const signingInput = header + "." + payload;
  const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return signingInput + "." + sig;
}

function verifyStravaState(token, secret, { now = Date.now() } = {}) {
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
  if (!claims || typeof claims.twitchId !== "string" || !claims.twitchId) return null;
  if (typeof claims.exp === "number" && Math.floor(now / 1000) >= claims.exp) return null;
  return claims;
}

module.exports = { signStravaState, verifyStravaState };
