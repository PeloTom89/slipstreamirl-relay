// tools/user-store.js — durable per-user store for multi-tenant features
// (Strava linking, per-user Anthropic keys), backed by Upstash Redis's REST
// API. CommonJS for the same reason as channel-token.js/stripe-entitlement.js:
// server.js is CommonJS and needs to require() this synchronously at request
// time — see AGENTS.md.
//
// NOT wired into server.js yet — this module is the storage primitive only.
// The Strava OAuth flow, key-upload endpoint, and recap changes that will
// consume it are separate follow-up work.
//
// Record shape, one JSON blob per Redis key `user:{twitchId}` (twitchId is
// the same Twitch user id verifyTwitchUser()/POST /channel-token already key
// on everywhere else in multi-tenant mode — no new id is invented here):
//
//   {
//     twitchId,
//     strava: { athleteId, refreshTokenEnc, scope, linkedAt } | null,
//     anthropicApiKeyEnc: string | null,
//     updatedAt,
//   }
//
// `refreshTokenEnc`/`anthropicApiKeyEnc` are ciphertext (AES-256-GCM, this
// module's own crypto, never Upstash's) — Upstash only ever sees encrypted
// bytes for secrets. The encryption key (TOKEN_ENCRYPTION_KEY) and the
// Upstash access token are deliberately two independent secrets: a leaked
// Upstash token alone must not be enough to decrypt anything. If
// TOKEN_ENCRYPTION_KEY is missing/malformed, createUserStore() throws at
// construction rather than silently falling back to plaintext.
//
// UPSTASH_API_BASE is a base-URL test seam, same convention as
// TWITCH_HELIX_BASE/STRIPE_API_BASE (see AGENTS.md) — defaults to the real
// UPSTASH_REDIS_REST_URL, overridden in tests to point at a local stub. Not
// documented in README's operator-facing env var tables, same as those two.

const crypto = require("crypto");

function parseEncryptionKey(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("TOKEN_ENCRYPTION_KEY is required (32 bytes, base64 or hex)");
  }
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      buf = null;
    }
  }
  if (!buf || buf.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex)");
  }
  return buf;
}

// AES-256-GCM: random 12-byte IV per call, auth tag verified on decrypt.
// Encoded as base64 "iv:tag:ciphertext" so it round-trips through a plain
// Redis string/JSON value with no binary-safety concerns.
function encrypt(keyBuf, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decrypt(keyBuf, encoded) {
  const parts = String(encoded).split(":");
  if (parts.length !== 3) throw new Error("malformed ciphertext");
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

function userKey(twitchId) {
  return "user:" + twitchId;
}

// ---- Upstash REST API helpers (Bearer token auth) ----
// Single-command REST form (GET /get/:key, POST /set/:key with the value as
// the raw request body) — no pipelining needed for this module's access
// pattern (one record per call).
async function upstashGet(apiBase, token, fetchImpl, key) {
  const r = await fetchImpl(apiBase + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + token },
  });
  if (!r.ok) throw new Error("upstash get failed: " + r.status);
  const j = await r.json();
  return j.result;
}

async function upstashSet(apiBase, token, fetchImpl, key, value) {
  const r = await fetchImpl(apiBase + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
    body: value,
  });
  if (!r.ok) throw new Error("upstash set failed: " + r.status);
}

function emptyRecord(twitchId) {
  return { twitchId, strava: null, anthropicApiKeyEnc: null, updatedAt: null };
}

function createUserStore({
  encryptionKey = process.env.TOKEN_ENCRYPTION_KEY,
  upstashUrl = process.env.UPSTASH_REDIS_REST_URL,
  upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN,
  apiBase = process.env.UPSTASH_API_BASE || upstashUrl,
  fetchImpl = fetch,
} = {}) {
  const key = parseEncryptionKey(encryptionKey);
  if (!upstashUrl) throw new Error("upstashUrl (UPSTASH_REDIS_REST_URL) required");
  if (!upstashToken) throw new Error("upstashToken (UPSTASH_REDIS_REST_TOKEN) required");

  async function getUser(twitchId) {
    const raw = await upstashGet(apiBase, upstashToken, fetchImpl, userKey(twitchId));
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function saveUser(record) {
    await upstashSet(apiBase, upstashToken, fetchImpl, userKey(record.twitchId), JSON.stringify(record));
    return record;
  }

  async function putStravaLink(twitchId, { athleteId, refreshToken, scope }) {
    const existing = (await getUser(twitchId)) || emptyRecord(twitchId);
    const record = {
      ...existing,
      twitchId,
      strava: {
        athleteId,
        refreshTokenEnc: encrypt(key, refreshToken),
        scope,
        linkedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    return saveUser(record);
  }

  async function putAnthropicKey(twitchId, apiKey) {
    const existing = (await getUser(twitchId)) || emptyRecord(twitchId);
    const record = {
      ...existing,
      twitchId,
      anthropicApiKeyEnc: encrypt(key, apiKey),
      updatedAt: new Date().toISOString(),
    };
    return saveUser(record);
  }

  async function deleteStravaLink(twitchId) {
    const existing = await getUser(twitchId);
    if (!existing) return null;
    const record = { ...existing, strava: null, updatedAt: new Date().toISOString() };
    return saveUser(record);
  }

  // Decrypted read helpers — for in-process use only. Decrypt immediately
  // before use; never log the returned plaintext.
  async function getStravaRefreshToken(twitchId) {
    const record = await getUser(twitchId);
    if (!record || !record.strava || !record.strava.refreshTokenEnc) return null;
    return decrypt(key, record.strava.refreshTokenEnc);
  }

  async function getAnthropicKey(twitchId) {
    const record = await getUser(twitchId);
    if (!record || !record.anthropicApiKeyEnc) return null;
    return decrypt(key, record.anthropicApiKeyEnc);
  }

  return {
    getUser,
    putStravaLink,
    putAnthropicKey,
    deleteStravaLink,
    getStravaRefreshToken,
    getAnthropicKey,
  };
}

module.exports = {
  createUserStore,
  parseEncryptionKey,
  encrypt,
  decrypt,
};
