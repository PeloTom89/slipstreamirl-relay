#!/usr/bin/env node
// tools/mint-channel-token.js — manual/ops tool to mint a per-channel push JWT
// for server.js's MULTI_TENANT mode, ahead of any automated issuance flow
// (app-side auto-provisioning and entitlement-gated renewal are separate,
// later roadmap items — see ROADMAP.md).
//
// Usage:
//   RELAY_JWT_SECRET=... node tools/mint-channel-token.js <channelId> [ttlSeconds]
//
// Print the token to the streamer, who pastes it (plus the channel id) into
// the app's relay settings. Overlay URLs never need this token — only /push.

const { signChannelToken } = require("./channel-token.js");

const [, , channel, ttlArg] = process.argv;
const secret = process.env.RELAY_JWT_SECRET;

if (!channel) {
  console.error("usage: RELAY_JWT_SECRET=... node tools/mint-channel-token.js <channelId> [ttlSeconds]");
  process.exit(1);
}
if (!secret) {
  console.error("RELAY_JWT_SECRET env var required (must match the relay's own RELAY_JWT_SECRET)");
  process.exit(1);
}

const ttlSeconds = ttlArg ? Number(ttlArg) : undefined;
if (ttlArg && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
  console.error("ttlSeconds must be a positive number");
  process.exit(1);
}

console.log(signChannelToken(channel, secret, ttlSeconds ? { ttlSeconds } : {}));
