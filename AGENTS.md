# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Tests: `npm test` runs Node's built-in test runner (`node --test tools/*.test.mjs`) —
  no external test framework is installed. Put unit-testable logic under `tools/*.mjs`
  with a matching `tools/*.test.mjs`.
- `.github/workflows/strava-youtube-comment.yml`'s `run:` step is still a
  `node --input-type=module <<'EOF' ... EOF` heredoc, but it is now thin
  glue: read env/inputs, call extracted functions in order, done. The actual
  recap logic lives in `tools/strava-client.mjs` (token refresh, activity
  lookup/detail, segment-popularity ranking, description/title write-back),
  `tools/road-matching.mjs` (GPS-trace-to-road-name matching via Mapbox,
  consolidated with the aggregation in `tools/road-names.mjs`),
  `tools/recap-writer.mjs` (prompt building + the Claude call), and
  `tools/youtube-client.mjs` (latest-upload lookup, OAuth refresh, YouTube
  description mirroring) — each with a `tools/*.test.mjs` under the `npm
  test` glob. GitHub Actions `run:` steps execute with cwd = the checked-out
  repo root, so the heredoc `import`s these as normal repo-relative paths
  (e.g. `./tools/road-names.mjs`, the original precedent for this pattern)
  with no build step. This split was done specifically so the recap logic
  is callable/testable outside the heredoc — groundwork for a future
  per-user change that loops it over many users' stored credentials (not
  yet done: today it's still hardwired to one Strava account via repo
  secrets).
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
- `BETA_OPEN_ACCESS` (server.js) drops the payment/allowlist check entirely
  for everyone during a beta — any identity-verified Twitch caller is
  entitled. Unlike `BETA_ALLOWLIST_TWITCH_IDS`, it deliberately does NOT
  require `entitlementStore`/Stripe to be configured (checked before the 503
  "entitlement not configured" branch, not after), since the whole point is
  testers don't need a Stripe subscription behind them. Identity verification
  is still never skipped. See README.md "Beta allowlist" for the full
  contract; clear it before charging real customers, same as the allowlist.
- `tools/beta-allowlist-remote.js` (`BETA_ALLOWLIST_REMOTE_URL`) is the
  optional remote source merged into that same allowlist, so the operator can
  add a tester without an env var change (a redeploy drops connections and
  wipes in-memory ride state). Its one load-bearing rule: a fetch that fails,
  or parses to **zero** valid ids, must never replace the last known good
  list — that's what stops a network blip or a typo/garbage source from
  silently revoking every beta tester. Any change to its fetch/parse path
  needs a test proving that rule still holds, not just a happy-path test —
  see README.md "Beta allowlist" for the full design.
- Three env vars exist purely as test seams and are never meant to be set in
  production: `TWITCH_HELIX_BASE`, `STRIPE_API_BASE`, and `UPSTASH_API_BASE`
  (all default to the real API hosts). Integration tests point these at a
  local stub HTTP server so `tools/relay-entitlement.test.mjs` and
  `tools/user-store.test.mjs` can exercise their respective endpoints
  end-to-end without live Twitch, Stripe, or Upstash credentials. Don't
  document these in README.md's operator-facing env var tables — they're not
  something the operator ever needs to set. The recap modules
  (`tools/strava-client.mjs`, `tools/road-matching.mjs`,
  `tools/recap-writer.mjs`, `tools/youtube-client.mjs`) follow the same seam
  pattern but as factory-function options (`apiBase`/`oauthBase`/`fetchImpl`,
  defaulting to the real hosts) rather than env vars, since they're plain
  importable modules, not `server.js` — same "don't document in README" rule
  applies.
- `tools/user-store.js` is the relay's only durable per-user store (keyed on
  the Twitch user id, the same identity `verifyTwitchUser()`/`POST
  /channel-token` already use — no separate id) — one JSON blob per Redis key
  `user:{twitchId}`, backed by Upstash Redis's REST API (`UPSTASH_REDIS_REST_URL`
  / `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_API_BASE` test seam per the point
  above). CommonJS for the same `server.js`-`require()`s-this-synchronously
  reason as `channel-token.js`/`stripe-entitlement.js`. Secrets
  (`strava.refreshTokenEnc`, `anthropicApiKeyEnc`) are AES-256-GCM ciphertext
  produced by this module's own `crypto` before anything reaches Upstash — the
  encryption key (`TOKEN_ENCRYPTION_KEY`) and the Upstash access token are
  deliberately two independent secrets, so a leaked Upstash token alone can't
  decrypt anything; `createUserStore()` throws at construction if
  `TOKEN_ENCRYPTION_KEY` is missing/malformed rather than falling back to
  plaintext. Wired into `server.js`'s Strava account linking endpoints (see
  below) via `putStravaLink`/`getStravaRefreshToken`/`deleteStravaLink`; the
  per-user Anthropic key it also stores (`putAnthropicKey`/`getAnthropicKey`)
  and the recap-generation changes that would consume either are still
  separate follow-up work. Unlike `stripe-entitlement.js`, this module's
  whole point IS durable local state — don't conflate the two or apply
  stripe-entitlement's "zero durable state" rule here.
- **Strava account linking** (`GET /strava-authorize`, `GET /strava-callback`,
  `POST /strava-deauthorize` in `server.js`; helpers in
  `tools/strava-oauth.js` and `tools/strava-state-token.js`) is the first
  per-user piece of making Strava recaps multi-tenant — link → store
  (encrypted, via `tools/user-store.js`) → unlink, end to end. It does **not**
  yet change recap generation, which is still hardwired to one account via
  GitHub Actions secrets (see the workflow entry above) — a separate
  follow-up wires the recap runner to read from `tools/user-store.js` per
  user instead. Gated the same way as `/channel-token`: `404` outside
  `MULTI_TENANT`, `503` if the user store or `STRAVA_CLIENT_ID`/
  `STRAVA_CLIENT_SECRET` aren't configured. The OAuth `state` param
  (`tools/strava-state-token.js`) is what stops a Strava account being linked
  onto the wrong Twitch id — same HS256 `{claim, iat, exp}` shape as
  `tools/channel-token.js` but a **separate module with a different claim
  name** (`twitchId` vs `channel`) so a channel push token and Strava link
  state can never be replayed as each other, even though both are signed with
  `RELAY_JWT_SECRET`. Unlink is a three-step sequence that must stay in that
  order: refresh → revoke at Strava (`POST /oauth/deauthorize`) → delete
  locally; if either of the first two steps fails, the local link is
  deliberately left intact (`502`) rather than silently forgotten while still
  live at Strava. See README.md "Strava account linking" for the full
  contract and setup steps; `tools/relay-strava.test.mjs` covers all of the
  above end-to-end against stubbed Twitch/Strava/Upstash.
- **Per-user Strava recaps** (`tools/per-user-recap.mjs`,
  `tools/user-store.js`'s `listLinkedUsers()`, and the "Per-user Strava
  recaps" step in `.github/workflows/strava-youtube-comment.yml`) loop the
  same recap flow — `strava-client.mjs`/`road-matching.mjs`/
  `recap-writer.mjs`, reused unmodified — over every user linked via
  **Strava account linking** above, on top of (not instead of) the original
  single-account run. `listLinkedUsers()` is a paginated Upstash `SCAN` over
  `user:*` (path-style REST command: `/scan/<cursor>/match/<pattern>/count/<n>`,
  followed to cursor `"0"` — never assume one page), filtered to records that
  actually hold a live `strava` link. Deliberately **YouTube-free** — no
  video lookup, no YouTube mirroring, per the approved scope decision; gated
  instead by its own `RECAP_MARKER` string in the activity description (there's
  no YouTube-link check to reuse for idempotency). LLM key selection is each
  user's own decrypted `anthropicApiKeyEnc` if present, else the captain's
  `ANTHROPIC_API_KEY` — graceful degradation, not a hard requirement. The new
  workflow step is **independent of the captain's YOUTUBE_*/single-account
  secrets** (only needs `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` — shared
  Strava API app — plus `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`/
  `TOKEN_ENCRYPTION_KEY`), so a captain without YouTube configured still gets
  per-user recaps; it exits cleanly (zero users processed) when those three
  store secrets are absent. Dedupes the captain's own account (if also linked
  via the store) by Strava **athlete id** (via `strava-client.mjs`'s
  `getAuthenticatedAthlete()`), not Twitch id — the secret-based credential
  and a store-linked credential are two independent tokens for the same
  athlete. Per-user failure isolation has two distinct paths in
  `runPerUserRecaps()`: a refresh-token failure is tagged
  `err.code === "STRAVA_AUTH_FAILURE"` and triggers `deleteStravaLink()` (self-
  heal — the user revoked access, stop retrying forever); any other failure
  (Strava/Claude/network) is just logged by twitch id and the loop continues —
  neither aborts the run or touches another user. Strava's rate limit is
  **per-application**, shared across every user this loop processes (see the
  comment at the top of `tools/per-user-recap.mjs`) — fine at beta scale, a
  future scale-up should throttle. See README.md "Per-user Strava recaps" for
  the full contract; `tools/per-user-recap.test.mjs` and the `listLinkedUsers`
  suite in `tools/user-store.test.mjs` cover this against stubs — the live
  per-user round-trip against real Strava accounts is unverified until the
  three store secrets are set on the repo and a real linked user has an
  activity (use `workflow_dispatch` with `dry_run` to sanity-check without
  writing anything).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
