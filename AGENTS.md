# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Tests: `npm test` runs Node's built-in test runner (`node --test tools/*.test.mjs`) —
  no external test framework is installed. Put unit-testable logic under `tools/*.mjs`
  with a matching `tools/*.test.mjs`.
- `.github/workflows/strava-youtube-comment.yml` has no companion `.js`/`.mjs` file —
  its logic is a `node --input-type=module <<'EOF' ... EOF` heredoc inline in the YAML
  `run:` step. GitHub Actions `run:` steps execute with cwd = the checked-out repo root,
  so that heredoc can `import` a normal repo-relative path (e.g. `./tools/road-names.mjs`)
  and does — this is how testable logic gets shared with that workflow without duplicating
  it inline.
- `server.js` supports an opt-in multi-tenant mode (`MULTI_TENANT=1` +
  `RELAY_JWT_SECRET`) — see README.md "Multi-tenant mode" for the contract and
  ROADMAP.md "Big bet" for what's still open. Default (mode off) behaviour is
  covered by `tools/relay-server.test.mjs`'s "single-tenant mode" suite, which
  exists specifically to prove the opt-in flag didn't change the default path.
- **The broadcast/channel hazard.** `broadcast()`/`emit()` in `server.js`
  rebuild every payload from scratch rather than forwarding it, and take an
  explicit `channel` state bundle rather than closing over module state. This
  means there are now **two** independent ways a new message type can go
  wrong, not one: (1) the pre-existing hazard — a field not explicitly handled
  in both `/push` validation and `broadcast()`/`emit()` is silently dropped
  (this was a real bug, hence the warning in README.md/ROADMAP.md); (2) the
  channel-routing version of the same class of bug — a message reaching the
  wrong channel's overlays, or no channel at all, because some new code path
  reads/writes a `last*` field on the wrong `channel` object or bypasses the
  channel argument. Neither fails loudly. Any change to `emit()`/`broadcast()`
  needs a cross-channel isolation test added to `tools/relay-server.test.mjs`
  covering the new/changed message type, following the existing
  `MESSAGE_CASES` pattern there — not just a single-channel functional test.
- `tools/channel-token.js` is CommonJS (`.js`, not the `tools/*.mjs` convention
  `road-names.mjs` established) because `server.js` is CommonJS and needs to
  `require()` it synchronously at request time; a `.mjs` module can't be
  `require()`'d. Its test file is still `tools/channel-token.test.mjs` per the
  `npm test` glob — Node's ESM loader can import CJS named exports from a
  plain `module.exports = {...}` object fine, confirmed working here.
- **Stripe entitlement (`tools/stripe-entitlement.js`, gates `POST
  /channel-token`) deliberately keeps zero durable local state** — Render's
  free plan has an ephemeral filesystem and sleeps, so any local store of
  "who has paid" (a file, or a plain in-memory map with nothing behind it)
  silently un-entitles paying customers on the next restart. Stripe itself is
  the sole source of truth for both subscription status and the Twitch↔Stripe
  identity link (`metadata.twitch_id`). A webhook-warmed in-memory cache is
  just a speed optimization; a cache miss/restart self-heals via one
  read-only Stripe Search API call keyed on that same metadata. See README.md
  "Stripe entitlement" before changing anything here — the "no durable state"
  property is the entire point, not an oversight to "fix" by adding a
  database. **One exception:** `createSubscriptionMetadataWriter` performs a
  single narrowly-scoped write (`POST /v1/subscriptions/:id`,
  `metadata.twitch_id` only) from the `checkout.session.completed` handler,
  because `client_reference_id` — Checkout's identity field when the operator
  uses that mechanism instead of a metadata-templated Payment Link — lives
  only on the Checkout Session and nowhere `reconcile()` can re-query later;
  without this write the identity link died with the in-memory cache on
  every restart. This does not reintroduce local durable state — it makes
  Stripe durably hold the link, consistent with the module's own principle —
  but it does mean `STRIPE_SECRET_KEY` is no longer read-only. Any future
  change to this module must keep that one write exactly that narrow (one
  metadata key, one endpoint, one call site); don't add a second write path
  without the same restart-safety reasoning applied.
- `tools/spawn-relay.mjs` holds the shared "spawn a real server.js child
  process on a random port" helper used by both `tools/relay-server.test.mjs`
  and `tools/relay-entitlement.test.mjs`. It intentionally does not match the
  `tools/*.test.mjs` glob `npm test` runs, so it's a plain importable module,
  not a test suite itself.
- `BETA_ALLOWLIST_TWITCH_IDS` (server.js) bypasses only the *payment* half of
  `POST /channel-token`'s entitlement check — Twitch identity verification is
  never skipped, and the check is only reachable when `entitlementStore`
  exists (i.e. Stripe is otherwise configured). See README.md "Beta
  allowlist" for the full contract; the operator must clear it before charging
  real customers.
- `tools/beta-allowlist-remote.js` (`BETA_ALLOWLIST_REMOTE_URL`) is the
  optional remote source merged into that same allowlist, so the operator can
  add a tester without an env var change (a redeploy drops connections and
  wipes in-memory ride state). Its one load-bearing rule: a fetch that fails,
  or parses to **zero** valid ids, must never replace the last known good
  list — that's what stops a network blip or a typo/garbage source from
  silently revoking every beta tester. Any change to its fetch/parse path
  needs a test proving that rule still holds, not just a happy-path test —
  see README.md "Beta allowlist" for the full design.
- Two env vars exist purely as test seams and are never meant to be set in
  production: `TWITCH_HELIX_BASE` and `STRIPE_API_BASE` (both default to the
  real API hosts). Integration tests point these at a local stub HTTP server
  so `tools/relay-entitlement.test.mjs` can exercise `POST /channel-token`
  and `POST /stripe-webhook` end-to-end without live Twitch or Stripe
  credentials. Don't document these in README.md's operator-facing env var
  tables — they're not something the operator ever needs to set.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
