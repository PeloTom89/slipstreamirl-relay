# SlipstreamIRL Relay

The backend for **SlipstreamIRL** — a small Node service (deploys on Render, e.g.
`irl-stream-control`) that relays your phone's GPS and bike-sensor data to live OBS
overlays, serves a Twitch Extension preview, and runs a scheduled job that
auto-links each ride's YouTube VOD (with an AI-written title/description) back to
Strava.

Phone (the [app](https://github.com/PeloTom89/slipstreamirl-app)) → this relay →
your OBS browser source. No RTIRL, no third-party location service.

**Status: beta.** The free, self-hosted deploy below is currently the only way
to run this. There's no live hosted service to sign up for.

## What it does

- Receives GPS, speed, distance, and BLE sensor data (power/cadence/heart rate)
  from the app over `POST /push`, and fans it out to connected overlays via WebSocket.
- Serves the overlay pages OBS points at — a **vector map** (MapLibre, course-up
  rotation, upright labels), a Karoo-style bike-computer card row, and a chat ticker.
- Caches the whole ride's GPS breadcrumb and Varia radar targets, and replays them
  to any overlay that connects mid-ride (so a refreshed OBS source doesn't lose the
  trail or snap to a stale position).
- Serves a static preview of the Twitch Extension under `/ext` (mirrors the app's
  in-app **Extension** preview tab).
- Bounces Twitch's OAuth redirect (`/app-redirect`) so the app can sign in, and
  proxies Twitch chat badge images for the chat overlay.
- Backs two app features that talk to Claude server-side (the API key never
  reaches the phone): generating a Twitch title from a dictated **Voice Ride Plan**,
  and storing a dictated **Voice Ride Summary** (per Twitch user, in the durable
  per-user store — see **Voice ride summary** below) for the Strava workflow below.
- Runs a **scheduled GitHub Action** (`.github/workflows/strava-youtube-comment.yml`)
  that finds your latest YouTube upload, matches it to the Strava activity you
  just rode, and updates that activity's title + description — written by Claude
  from the activity stats, popularity-ranked Strava segments, the *real* roads you
  rode (GPS map-matched via Mapbox, optional), and your dictated ride notes if any.

## Files & routes

| file | route | what |
|---|---|---|
| `server.js` | — | the relay (HTTP + WebSocket); `/` returns a status line |
| `overlay-gl.html` | `/overlay`, `/overlay-gl` | **MapLibre vector** map overlay — rider marker, wind, breadcrumb trail, Varia radar, course-up rotation |
| `overlay.html` | `/overlay-raster` | old Leaflet raster map, kept as a fallback |
| `karoo.html` | `/karoo` | bike-computer overlay (speed, distance, 3s power, cadence, heart); embeds `/overlay` for its map |
| `chat.html` | `/chat` | Twitch chat ticker |
| `ext/` | `/ext/*` | static copy of the Twitch Extension bundle (MapLibre `video_overlay.html` + `overlay.js`), served for the app's in-app Extension preview |
| `tools/simulate-gpx.mjs` | — | dev tool: replay a GPX route into the relay without actually riding |
| `tools/road-names.mjs` | — | groups Mapbox map-matching step names into de-duped, ranked roads for the workflow below (`npm test`) |
| `tools/channel-token.js` | — | signs/verifies the per-channel push JWT used by multi-tenant mode (below) |
| `tools/mint-channel-token.js` | — | ops CLI: mints a channel's push token (multi-tenant mode) |
| `tools/stripe-entitlement.js` | — | Stripe webhook verification + entitlement cache/reconciliation (see **Stripe entitlement** below) |
| `tools/user-store.js` | — | durable per-user store (Strava links, per-user Anthropic keys), Upstash-backed (see **Durable per-user store** below) |
| `tools/strava-oauth.js` | — | Strava OAuth authorize-URL/token-exchange/refresh/deauthorize helpers (see **Strava account linking** below) |
| `tools/strava-state-token.js` | — | signs/verifies the `state` param binding a Strava link attempt to the verified Twitch id |
| `.github/workflows/strava-youtube-comment.yml` | — | scheduled job, see **Strava/YouTube auto-post** below |
| `render.yaml` | — | Render Blueprint (auto-provisions the service + token) |

Endpoints: `POST /push` (sender), `GET /health` (token check), `GET /badges`
(chat badges), `GET /app-redirect` (Twitch OAuth bounce), `POST /ai/twitch-title`
(Claude ride-plan → title), `POST /ride-summary` (stores a dictated post-ride
summary for the workflow below, per Twitch user — multi-tenant mode, see
**Voice ride summary** below), `POST /channel-token` (entitlement-gated
channel push token issuance, multi-tenant mode), `POST /stripe-webhook`
(Stripe entitlement events, multi-tenant mode), `GET /strava-authorize` /
`GET /strava-callback` / `POST /strava-deauthorize` (per-user Strava account
linking, multi-tenant mode — see **Strava account linking** below),
`POST /settings/anthropic-key` (per-user Anthropic key, multi-tenant mode —
see **Per-user Anthropic key** below), WebSocket `?role=overlay|sender`.

## Overlay features

- **Vector map** (MapLibre + OpenFreeMap, no API key) — street/landmark labels stay
  upright as the map rotates, unlike the old raster tiles.
- **Course-up rotation** by default (`?north=1` forces north-up).
- **Breadcrumb trail** — the relay caches the whole ride's path server-side, so a
  late-joining or refreshed overlay sees the full route, not just what's happened
  since it connected. `?trail=off` disables it.
- **Varia radar strip** — shows approaching vehicles from a paired Garmin Varia,
  pushed by the app.
- **Wind arrows** — direction/speed from Open-Meteo, scaled to real ground speed at
  the map's current zoom/latitude (exaggerated for visibility). Toggleable.
- **Effort-zone colors** — Karoo card values tint green→purple from `{zones}` anchors.
- Query params on both overlays: `?embed=1` (flush, no rounded corners — used by
  the in-app preview/Karoo embed), `?wind=off`, `?units=metric`, `?trail=off`, `?north=1`.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PeloTom89/slipstreamirl-relay.git)

1. Create a **Public** Twitch app at <https://dev.twitch.tv/console/apps>; copy the **Client ID**.
2. Click Deploy (or Render → New → Blueprint → this repo). Paste the Client ID into
   `TWITCH_CLIENT_ID`; Render generates `RELAY_TOKEN`. Deploy.
3. Copy your service URL (e.g. `https://irl-stream-control.onrender.com`).
4. On the Twitch app, add `<your-url>/app-redirect` as an OAuth Redirect URL (exact match).
5. In the app, enter the relay URL + token under **Relay Server**. In OBS, add a
   Browser Source for `<your-url>/overlay` and/or `<your-url>/karoo`.

### Env vars that matter for a normal deploy

- `TWITCH_CLIENT_ID` — your Twitch app Client ID.
- `RELAY_TOKEN` — shared secret the **sender** (app) must present; overlays are
  read-only and need no token.
- `CLIENT_SECRET` *(optional)* — enables chat badge images via Twitch Helix.
- `ANTHROPIC_API_KEY` *(optional)* — enables the Voice Ride Plan title-generation
  endpoint (`/ai/twitch-title`).
- `ANDROID_APK_URL` *(optional)* — the operator-updated pointer to the **current**
  Android build's direct artifact URL (the raw
  `https://expo.dev/artifacts/eas/…apk` value). Powers `GET /download/android`, a
  stable public redirect that also counts downloads (a plain Upstash `INCR` on
  `stats:android-downloads`, surfaced on the `/` status line; needs
  `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — see **Durable per-user
  store** for those, but counting is best-effort and never blocks the download).
  Unset → `/download/android` returns `503` (never a broken redirect).
  **When a new Android build ships, updating this env var is the only step
  needed** — do not edit the website or Discord links. Everywhere that used to
  link the raw Expo artifact should now link the stable URL
  `https://relay.slipstreamirl.com/download/android` instead, which never changes.

> `GITHUB_CONTENT_PAT` (and the "commit `data/ride-summary.json` into this repo"
> mechanism it enabled) is **retired** — `/ride-summary` now writes to the durable
> per-user store instead. See **Voice ride summary** below. If this PAT is still
> set on your deploy, it's unused and safe to remove — the relay no longer needs
> repo-content-write access to anything.

Everything below (`MULTI_TENANT`, `STRIPE_*`, `BETA_ALLOWLIST_*`) is optional
and off by default; a plain deploy with just the vars above behaves exactly
as described in this section.

### Notes

- **Cold start:** the free Render tier sleeps after ~15 min idle (30–50s to wake).
  Connect a minute before going live.
- **Single-tenant by default:** one streamer per relay (one token, one room) —
  unchanged unless you opt into **multi-tenant mode** (below).
- The token is visible in the served control page's JS, so treat the relay URL as private.

## Push protocol

The app pushes JSON to `POST /push?token=…` (in multi-tenant mode,
`POST /push?channel=<id>&token=<channel JWT>` — see **Multi-tenant mode**
below). Beyond a normal position fix, several **keyless** control messages
are supported (no lat/lng required):

| message | meaning |
|---|---|
| `{lat,lng,acc,hdg,spd,dist}` | position fix |
| `{hidden:true}` | inside the privacy geofence (overlay freezes to "?") |
| `{offline:true}` | stream ended — hide the marker |
| `{wind:bool}` | wind arrows on/off |
| `{units:"imperial"\|"metric"}` | units preference |
| `{power,cadence,hr}` | BLE sensor values |
| `{zones:{enabled,ftp,lthr,maxhr,cadence,speed}}` | effort-zone anchors |
| `{radar:[...]}` | Garmin Varia radar targets |
| `{path:[[lat,lng],...]}` | full breadcrumb-trail replay for late-joining overlays |
| `{liveStart}` | go-live timestamp, for the overlay's elapsed timer |
| `{delay:<seconds>}` | broadcast delay, to sync overlay data with the stream's real-world latency |

`broadcast()` rebuilds each payload and caches the latest of each kind
(`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/`lastRadar`/`lastPath`),
replaying them to any overlay that connects later. **Any new keyless message must be
allowed in both `/push` validation and `broadcast()`, or it's silently dropped.**

## Multi-tenant mode

Off by default — every deploy keeps working exactly as documented above, with
no config change. This is an **opt-in mode of the same `server.js`**, not a
fork, for hosting more than one streamer's room from a single relay instance.

**Enable it** with two env vars:

- `MULTI_TENANT=1`
- `RELAY_JWT_SECRET=<a long random string>` — signs/verifies push tokens. The
  server refuses to start if `MULTI_TENANT=1` and this is unset.

**What changes when it's on:**

- All per-ride state (`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/
  `lastZones`/`lastRadar`/`lastPath`/`delayMs`) and the overlay `Set` become
  per-channel, keyed by channel id (the streamer's Twitch user id). Each
  channel is its own isolated room — see `tools/relay-server.test.mjs` for the
  isolation guarantees this is tested against.
- Every relay-facing URL takes `?channel=<id>`:
  - Overlays: `/overlay?channel=<id>`, `/overlay-gl?channel=<id>`,
    `/overlay-raster?channel=<id>`, `/karoo?channel=<id>` (which forwards it to
    its embedded `/overlay` iframe too). Overlays stay **read-only and public
    by channel id** — no token in the URL, since OBS browser-source URLs get
    shown on stream. `chat.html`'s own `?channel=` is unrelated — it's the
    Twitch **login name** used to join Twitch IRC directly, not a relay room;
    `/chat` never opens a relay WebSocket at all, so it needs no change here.
  - Sender: `POST /push?channel=<id>&token=<channel JWT>`, or WebSocket
    `?role=sender&channel=<id>&token=<channel JWT>`.
  - `GET /health?channel=<id>&token=<channel JWT>`.
- A channel id with no `?channel=` on `/push`, a sender WebSocket, or an
  overlay WebSocket is rejected (`400`/close `1008`). A channel is created
  lazily in memory on first authenticated `/push` or sender-WebSocket message
  — nothing to provision. An overlay WebSocket only *joins* an already-created
  channel; connecting to a channel id that hasn't been pushed to yet is
  rejected (close `1008`) rather than creating one, so an unauthenticated
  overlay URL can't be used to grow server memory with channels that never
  receive data. This is self-healing: the overlay pages already retry the
  WebSocket every 2s on close, so adding an OBS browser source before the
  first push just means it connects a couple of seconds after the stream's
  first location fix instead of immediately.

**Token model.** The push token is a minimal HS256 JWT (`tools/channel-token.js`,
no `jsonwebtoken` dependency — just Node's `crypto`) with claims
`{ channel, iat, exp }`, signed with `RELAY_JWT_SECRET`. `/push` and the sender
WebSocket verify the signature and expiry, and that `claims.channel` matches
the `?channel=` on the request — a token minted for one channel is rejected on
any other.

**Issuing a token.** Two ways, and both remain available:

- **Manual (ops tool)** — the simplest path for any channel you want to run
  without wiring up Stripe at all:
  ```
  RELAY_JWT_SECRET=... node tools/mint-channel-token.js <channelId> [ttlSeconds]
  ```
- **Automatic, entitlement-gated (`POST /channel-token`)** — see **Stripe
  entitlement** below. This path only issues a token to someone with an
  active (or recently active, see grace period) Stripe subscription, and
  falls back to unavailable (503) rather than issuing anything when Stripe
  isn't configured — in which case the manual tool above keeps working
  exactly as before.

The `exp` claim is what makes entitlement expiry-based rather than a live
per-push billing check — see **Stripe entitlement** below for why that
matters.

**Not in scope of this mode:** Redis, multi-instance fan-out, or any
horizontal scaling — a single instance handles far more load than typical
usage will see. Ride data is still never persisted to disk in this mode
either — per-channel state is in-memory only, same privacy property as
single-tenant mode (see **Notes** above). The entitlement cache added below
lives in its own separate in-memory `Map`, keyed by Twitch id — it never
touches, and is never touched by, the per-channel ride-state `Map`, so adding
billing state hasn't made ride data durable as a side effect.

## Strava/YouTube auto-post workflow

`.github/workflows/strava-youtube-comment.yml` runs every 30 minutes (and can be
triggered manually). On each run it:

1. Looks for a YouTube upload in the last 24 hours, and your latest Strava activity
   (skips cleanly — not an error — if there's no new video yet, or the activity
   already has a YouTube link in its description).
2. Ranks Strava segments by rider popularity (`athlete_count`), not ride order —
   the well-known ones surface instead of one-off/auto-generated ones.
3. **Optionally** (if `MAPBOX_TOKEN` is set) fetches the ride's full GPS trace from
   Strava, map-matches it against the real road network via Mapbox, and ranks the
   actual roads ridden by distance covered. This is the one source of *real* road
   names — segments are Strava-defined efforts, not roads, and the prompt is
   explicit about not conflating the two.
4. Asks Claude for a plain, factual title + opening line from all of the above,
   plus your dictated ride notes if you recorded a Voice Ride Summary.
5. Updates the Strava activity's title/description, and mirrors the same text onto
   the YouTube video's own description (linking back to Strava), if YouTube OAuth
   is configured.

**Testing/manual controls** (all via `workflow_dispatch` inputs, never touch
anything real unless you ask them to):

| input | what it does |
|---|---|
| `dry_run` | logs the title/description Claude would generate; writes nothing |
| `rider_notes_override` | simulate with arbitrary ride notes (the real dictated summary in the store is usually already consumed by the time you want to preview) |
| `activity_id_override` | target a specific activity instead of whatever's "latest" |
| `title_override` + `opener_override` | skip Claude and apply this exact reviewed text to the activity (replaces the description instead of appending) |
| `list_recent` | logs your 10 most recent activity ids/names/dates — no Claude/Mapbox calls, no YouTube check |

### GitHub Actions secrets (separate from the Render env vars above)

`YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
`STRAVA_REFRESH_TOKEN`, `ANTHROPIC_API_KEY` (required); `MAPBOX_TOKEN` (optional —
enables real road-name matching); `YOUTUBE_OAUTH_CLIENT_ID` /
`YOUTUBE_OAUTH_CLIENT_SECRET` / `YOUTUBE_OAUTH_REFRESH_TOKEN` (optional — mirrors
the description onto the YouTube video too); `CAPTAIN_TWITCH_ID` plus
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` / `TOKEN_ENCRYPTION_KEY`
(optional — lets this step read/clear the operator's own dictated ride summary
from the durable per-user store; see **Voice ride summary** below). Without
`CAPTAIN_TWITCH_ID`, this step behaves exactly as if no summary was ever
recorded — it never fails for lacking it.

### Per-user Strava recaps

A second, independent step in the same workflow (`Per-user Strava recaps`) loops
the same recap flow over every user who has linked their own Strava account (see
**Strava account linking** below) — **not** just the one hardwired account above.
Each linked user gets their own Strava activity's title/description written from
their own latest ride, using their own stored Strava credential.

- **YouTube stays limited to the primary account.** The per-user step never
  looks at YouTube — no video-upload check, no YouTube description mirroring.
  It writes a title/opener/stat line straight to each user's own Strava
  activity, gated by a `— recap via SlipstreamIRL` marker in the description
  (rather than the "already has a youtube.com link" check the single-account
  path uses) so the same activity isn't re-processed on the next run.
- **LLM key selection:** each user's own `anthropicApiKeyEnc`, if the app-side
  upload for it has landed and they've set one; otherwise falls back to the
  same `ANTHROPIC_API_KEY` secret the single-account path uses. A user without
  their own key still gets a recap.
- **Dictated ride notes:** if the rider recorded a Voice Ride Summary (see
  **Voice ride summary** below), it's read via `getRideSummary()` and folded
  into the recap prompt exactly like the single-account path's own dictated
  notes — and cleared via `clearRideSummary()` after a successful write, so a
  stale note isn't reused on the rider's next ride.
- **Operator dedupe:** if the operator's own account is *also* linked via the
  store (e.g. they link through the app too), that store entry is skipped —
  matched by Strava athlete id, not Twitch id — so their own activity isn't
  processed twice in one run; the step above already covers it.
- **Per-user failure isolation:** one user's failure (Strava/Claude error, rate
  limit, etc.) is logged by twitch/athlete id and the loop moves on — it never
  aborts the run or affects any other user. A refresh token that no longer
  works (the user revoked access from Strava's own settings) is treated as "no
  longer linked": the local link is deleted so the cron stops retrying it every
  30 minutes, same self-heal posture as Stripe reconciliation and the Mapbox
  fallback above.
- **Rate limit:** Strava's API limit is per-application, shared across every
  user this step processes (not per-athlete) — roughly 100-200 requests/15min,
  1000-2000/day on a standard app. Fine at beta scale; see the comment at the
  top of `tools/per-user-recap.mjs` if this needs throttling later.
- This step is **independent of the single-account secrets above** — it only
  needs `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` (the same Strava API
  application, shared across every user's token) plus the three durable-store
  secrets below. An operator who hasn't set up YouTube still gets per-user
  recaps once those are added. Respects the same `dry_run` `workflow_dispatch`
  input as the single-account step (simulates the same flow per user, writes
  nothing).

**Additional GitHub Actions secrets required** (on top of the ones above,
`STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` are shared with the single-account
step): `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`TOKEN_ENCRYPTION_KEY` — the same values set on the relay for the **durable
per-user store** below. Until these three are added to the repo's secrets,
this step logs a skip and exits cleanly — only the operator's single-account
run applies.

## Discord merge changelog

`.github/workflows/discord-merge-changelog.yml` posts a friendly, plain-English
"here's what just shipped" note to the SlipstreamIRL community Discord every
time a PR is merged into `main`. It's written for riders/streamers, not
developers — no engineering jargon, and honest ("behind-the-scenes
improvements") rather than invented user impact when a merge is purely
internal. Runs on `pull_request` (`types: [closed]`, gated on
`merged == true`) and also supports `workflow_dispatch` with an optional
`pr_number` input, so an already-merged PR can be re-posted as a test without
waiting for a new merge.

The pure request/payload logic (Claude call via forced tool-use for a clean
`{ headline, explanation }`, the Discord embed shape, the plain-title
fallback) lives in [`tools/discord-changelog.mjs`](tools/discord-changelog.mjs),
invoked directly by `node` from the workflow. This is a copy of the
**reference implementation** in `slipstreamirl-app`
(`.github/workflows/discord-merge-changelog.yml` +
`tools/discord-changelog.mjs`), with one deliberate format difference: **the
Discord embed here has no GitHub link** — no `embed.url`, no appended
`[Details](...)` line in the description. The footer is unchanged from the
reference (`repoName · by author`, e.g. "PeloTom89/slipstreamirl-relay · by
someuser") — see `buildDiscordPayload()` in `tools/discord-changelog.mjs` for
where that's implemented.

Requires two repo secrets (Settings ▸ Secrets and variables ▸ Actions):
- `DISCORD_WEBHOOK_URL` — the target channel's webhook. Not yet set on this
  repo; the workflow is inert until it is added.
- `ANTHROPIC_API_KEY` — already configured for the Strava/YouTube recap
  workflow above; this workflow reuses the same secret to generate the
  summary.

Missing either secret makes the workflow log "not configured — skipping" and
exit 0 — it's inert (no red X on every merge) until both are added. A merge
authored by a bot account (login ending `[bot]`, e.g. `dependabot[bot]`) is
skipped without calling Claude or Discord. If the Claude call errors or
returns something unusable, the workflow falls back to a minimal factual post
built from the PR title rather than posting nothing or posting broken/error
text.

## Stripe entitlement

This is an optional, opt-in layer on top of multi-tenant mode: it lets a
relay operator gate `POST /channel-token` (channel push-token issuance) on an
active Stripe subscription, instead of minting tokens by hand with
`tools/mint-channel-token.js`. It's part of the public code, so it's
documented here — but there's no hosted subscription product to sign up for;
if you're self-hosting without Stripe configured, this section doesn't apply
to you and `/channel-token` just answers 503.

**Design in one paragraph:** this relay deploys on Render's free plan
(ephemeral filesystem, sleeps on idle), so it keeps **no durable local
record** of who has paid. Stripe itself is the sole source of truth for both
subscription status and the Twitch↔Stripe identity link
(`metadata.twitch_id` on the Subscription). A webhook-warmed in-memory cache
is purely a speed optimization; a cache miss or restart self-heals via one
read-only Stripe Search API call. The **only** write this module makes is
narrowly scoped: when a Checkout Session's `client_reference_id` (rather than
`metadata.twitch_id`) carries the identity link, `checkout.session.completed`
triggers a single `POST /v1/subscriptions/:id` call that copies that id onto
`metadata.twitch_id` — because `client_reference_id` lives only on the
Session, which can't be re-queried later, and without this write the link
would be lost on the next restart. That endpoint can only set metadata; it
can't create, cancel, refund, or change price/status on anything. See
`tools/stripe-entitlement.js` for the full implementation and
`tools/stripe-entitlement.test.mjs` for its test coverage.

**The hot path is untouched.** `POST /push` (every ~3s while riding) never
calls Stripe and never checks entitlement — it only checks the per-channel
JWT's signature and expiry. Entitlement is checked once, at token
issuance/renewal (`POST /channel-token`), not per GPS fix. A lapsed
subscription means the *next* token isn't issued; an already-issued token
keeps working for its full lifetime regardless of what happens to the
subscription afterward.

**If Stripe is unreachable:** only `/channel-token` (renewal) is affected,
never a live ride. A Twitch id that's been positively confirmed entitled
before is trusted through a transient outage; an id that's never been seen,
or was last confirmed *not* entitled, is refused (`403`).

**Grace period:** `ENTITLEMENT_GRACE_SECONDS` (default 3 days) — how long a
lapsed/failed subscription still renews tokens before renewal is refused.
Errs generous, since a false allow costs a few days of service while a false
deny cuts off someone's stream.

**Events handled:** `customer.subscription.created` / `.updated` /
`.deleted`, `invoice.payment_failed`, and `checkout.session.completed` (only
for the identity-link write above — entitlement itself follows the
subsequent `customer.subscription.created`). See
`tools/stripe-entitlement.js` for exact behavior per event.

**If you want to run this yourself:** create a subscription Product/Price and
Payment Link (or Checkout) in your Stripe Dashboard, configure it to attach
`metadata.twitch_id` to the resulting Subscription/Customer (or use
`client_reference_id` on the Checkout Session — see the write behavior
above), and register a webhook endpoint at `https://<your-relay-url>/stripe-webhook`
subscribed to the events listed above. Set `STRIPE_SECRET_KEY` (a **secret**,
not publishable, key) and `STRIPE_WEBHOOK_SECRET` (shown when you register
the webhook) as env vars.

> **⚠️ The webhook URL must end in `/stripe-webhook`, not the bare root.**
> The relay's root path is its status page, which returns `200 OK` to any
> request — including Stripe's. Point the endpoint at the root by mistake and
> Stripe will report every delivery as successful while the relay processes
> nothing and entitlement silently never works, with no error surfaced
> anywhere. To confirm the endpoint is right, send it an unsigned request: a
> correctly configured `/stripe-webhook` **rejects** it with `400 bad
> signature`; a misrouted endpoint pointed at the root instead returns `200`.

### Beta allowlist

`BETA_ALLOWLIST_TWITCH_IDS` is an explicit, per-person, comma-separated list
of Twitch user ids exempt from the Stripe subscription check — useful for
letting a handful of testers use entitlement-gated multi-tenant mode without
setting up Stripe subscriptions for each of them.

- Absent or empty means nobody is allowlisted — never "everybody." Stray
  commas/whitespace parse to nothing, not an accidental match.
- Only bypasses the *payment* check. Identity is never weakened: the caller
  still has to present a Twitch access token that resolves to the
  allowlisted id, exactly like a paying subscriber.
- Only reachable when Stripe entitlement is otherwise configured — not a way
  to run hosted mode with no Stripe configuration at all.
- Tokens issued via the allowlist are indistinguishable downstream from a
  paying subscriber's token.
- Every allowlist-issued token logs a line naming the Twitch id, and the
  relay's root status page shows the current allowlisted-id count next to
  the channel count whenever the list is non-empty.
- Clear this env var before relying on the subscription check for real — it
  has no expiry and no separate kill switch beyond unsetting the var.

**`BETA_ALLOWLIST_REMOTE_URL`** lets you add a tester without a redeploy
(changing an env var redeploys the service, dropping connections and
clearing all in-memory ride state). It points the relay at a URL — a
[GitHub Gist](https://gist.github.com) raw link is the obvious choice — that
it polls (default every 5 minutes, `BETA_ALLOWLIST_REMOTE_REFRESH_SECONDS`)
for additional allowlisted ids, in the same comma/newline-separated numeric
format as the env var. Fetched ids are *merged with*
`BETA_ALLOWLIST_TWITCH_IDS`, never replacing it. **Don't commit this list to
this repo** — Render auto-deploys on every push to `main`, which would
trigger the redeploy this feature exists to avoid. A public Gist discloses
who has free access, so use a secret (unlisted) Gist if that matters to you.

Failure handling is deliberately conservative
(`tools/beta-allowlist-remote.js`): a fetch that errors, times out, returns
non-2xx, or parses to zero valid ids **keeps the last known good list**
rather than falling back to empty — so a network blip or a bad edit can
never silently revoke every tester at once. The fetch is bounded (timeout +
max response size), and only entries that look like real Twitch numeric ids
are accepted. The root status line shows whether the remote source is
`ok`/`stale`/`never-fetched`.

**`BETA_OPEN_ACCESS`** goes further than the allowlist: while set, *any*
Twitch account that can be identity-verified is entitled — no allowlisting,
no Stripe subscription, and (unlike the allowlist above) no Stripe
configuration at all is required. This is for a public beta where testers
shouldn't need a subscription or a hand-added id.

- Identity is never weakened: the caller still has to present a Twitch
  access token that `verifyTwitchUser()` resolves to a real Twitch id.
- Every token issued this way logs a line naming the Twitch id
  ("issued via beta open access"), and the root status page shows **"beta
  open access ON"** whenever the flag is set, so it's always obvious at a
  glance whether the relay is charging or wide open.
- **Clear this env var before charging real customers** — it has no expiry
  and overrides the Stripe/allowlist check entirely for everyone, not just a
  listed few.

### Env vars

- `STRIPE_SECRET_KEY` — Stripe secret API key. Used mostly for read calls,
  plus one narrowly-scoped write (see above).
- `STRIPE_WEBHOOK_SECRET` — the signing secret Stripe shows when you register
  the webhook endpoint. Required to verify `Stripe-Signature` — without this,
  the endpoint would accept a forged event from anyone, so both this and
  `STRIPE_SECRET_KEY` must be set together or entitlement stays off.
- `ENTITLEMENT_GRACE_SECONDS` *(optional, default `259200` = 3 days)*.
- `BETA_ALLOWLIST_TWITCH_IDS` *(optional)* — see **Beta allowlist** above.
- `BETA_ALLOWLIST_REMOTE_URL` *(optional)* — see **Beta allowlist** above.
- `BETA_ALLOWLIST_REMOTE_REFRESH_SECONDS` *(optional, default `300` = 5
  min)* — how often the URL above is re-polled.
- `BETA_OPEN_ACCESS` *(optional)* — see **Beta allowlist** above. Does not
  require `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` to be set.

## Durable per-user store

`tools/user-store.js` is a durable per-user store — Strava links and
per-user Anthropic keys, keyed on Twitch user id — backed by Upstash Redis's
free-tier REST API, with secrets encrypted application-side (AES-256-GCM)
before they ever reach Upstash. It's wired into **Strava account linking**
below and into the **per-user Strava recaps** step above via
`listLinkedUsers()` (a paginated `SCAN` over every `user:*` record, returning
only the ones with a live Strava link). Per-user Anthropic keys are uploaded
via **`POST /settings/anthropic-key`** — see **Per-user Anthropic key**
below.

- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — from your Upstash
  Redis database's REST API credentials.
- `TOKEN_ENCRYPTION_KEY` — 32 bytes, base64 or hex, used to encrypt/decrypt
  secrets before they're stored. Keep this **independent** from the Upstash
  token — a leaked Upstash credential alone must not be enough to decrypt
  anything stored there. Never commit it.

All three of the above must be set for the store to be active; any one
missing leaves it `null` and the Strava linking endpoints below answer `503`
rather than issuing anything or crashing at boot.

## Strava account linking

Lets a signed-in user connect **their own** Strava account from the app —
the first per-user piece of making Strava recaps multi-tenant. The recap
workflow above now loops over everyone linked here (**per-user Strava
recaps**), alongside the original single hardwired account via GitHub Actions
secrets, which keeps running unchanged. Multi-tenant
mode only (`MULTI_TENANT=1`), and only once both the **durable per-user
store** above and `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` below are set —
either piece missing leaves the three endpoints below answering `503`.

**Flow** (authorization-code OAuth, distinct from the app's Twitch *implicit*
flow — Strava's code is server-visible and must be exchanged server-side; the
refresh token never reaches the phone):

1. **`GET /strava-authorize?twitchAccessToken=...`** — the app opens this in
   an auth browser session (`WebBrowser.openAuthSessionAsync`, same pattern as
   the app's Twitch sign-in). The relay verifies the Twitch access token
   (`verifyTwitchUser()` — the same identity check `POST /channel-token`
   uses), mints a short-lived signed `state` binding the attempt to that
   Twitch id (`tools/strava-state-token.js` — same HS256 shape as the
   multi-tenant push JWT, signed with `RELAY_JWT_SECRET`, distinct claim so
   the two token kinds can't be swapped for each other), and `302`s to
   Strava's own authorize screen with scope `activity:read_all,activity:write`
   (`read_all` so recaps can see "Only You" activities; `write` so a later
   recap run can update the activity's title/description, same as the
   existing workflow does today).
2. **`GET /strava-callback?code=...&state=...&scope=...`** — Strava redirects
   here after the user approves/denies. The relay verifies `state` (rejecting
   missing/invalid/expired — it never trusts a Twitch id from anywhere else),
   exchanges `code` for tokens directly with Strava, and stores the refresh
   token via `putStravaLink()` (encrypted, see above). It then `302`s back
   into the app via its custom scheme with **only a success/failure signal**
   — `slipstreamirl://redirect?strava=linked` or `?strava=error` — mirroring
   how `/app-redirect` bounces Twitch sign-in back to the app. The
   `redirect_uri` sent to Strava is derived from the request's own `Host`
   header (`https://<this-host>/strava-callback`), so there's nothing extra
   to configure here beyond registering that same URL with Strava (below).
3. **`POST /strava-deauthorize`** *(body: `{"twitchAccessToken":"..."}"`)* —
   disconnects. Verifies identity the same way, refreshes to get a current
   Strava access token, calls Strava's own `/oauth/deauthorize` with it, and
   only **then** deletes the local link — unlinking actually revokes access
   at Strava, not just forgets it locally. If the refresh or the revoke call
   fails, the local link is deliberately left intact (`502`) rather than
   silently forgotten while still live at Strava.

**Setup (one-time, out-of-band):** register a Strava API application at
<https://www.strava.com/settings/api>, and add
`https://<your-relay-url>/strava-callback` as its **Authorization Callback
Domain**/redirect. Set `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` (Render
env vars — separate from the same-named GitHub Actions secrets the
Strava/YouTube workflow above uses, even though they're typically the same
Strava API application) on the relay. The feature is inert (`503`) until
these are set, the redirect is registered, and the durable per-user store
above is configured.

- `STRAVA_CLIENT_ID` — your Strava API application's Client ID.
- `STRAVA_CLIENT_SECRET` — its Client Secret. Never commit it.

## Per-user Anthropic key

`POST /settings/anthropic-key` lets a signed-in user upload their own
Anthropic API key so **per-user Strava recaps** (above) generate using their
key instead of the operator's `ANTHROPIC_API_KEY`. It's the same key the app
already stores on-device (Settings, used directly for the BYO-title feature)
— this endpoint just uploads a copy for the recap runner to read.
Multi-tenant mode only (`MULTI_TENANT=1`), and only once the **durable
per-user store** above is configured — otherwise it answers `503`.

Body: `{"twitchAccessToken":"...","anthropicApiKey":"..."}`. Identity comes
from `verifyTwitchUser()` on the Twitch access token, exactly like every
other authenticated endpoint here — a body-supplied Twitch id is never
trusted. On success the key is stored via `putAnthropicKey()` (encrypted, see
**Durable per-user store**) and the response is `200 {"ok":true}`. The key is
validated only as a bounded-length string (rejects anything over 200 chars or
non-string input) — it is never checked against Anthropic's API here.

**Clearing the key** (reverting to the operator's-key fallback): send the same
request with `anthropicApiKey` omitted or an empty string. Either shape
calls `deleteAnthropicKey()`.

The key is never logged. `tools/relay-anthropic-key.test.mjs` covers this
against stubbed Twitch/Upstash.

## Voice ride summary

`POST /ride-summary` lets a signed-in user store a voice-dictated post-ride
summary — recorded by the app right after `!stop` — so the Strava/YouTube
workflow above can fold their own words into their own recap. Multi-tenant
mode only (`MULTI_TENANT=1`), and only once the **durable per-user store**
above is configured — otherwise it answers `503`.

Body: `{"twitchAccessToken":"...","summary":"...","recordedAt":"..."}`.
Identity comes from `verifyTwitchUser()` on the Twitch access token, exactly
like every other authenticated endpoint here — a body-supplied Twitch id is
never trusted. On success the summary is stored via `putRideSummary()` and
the response is `200 {"ok":true}`. Unlike the Strava refresh token / Anthropic
key above, the summary is stored **as plaintext** — it's low-sensitivity
dictated rider text, not a credential.

- **Per-user Strava recaps** (above) reads each linked user's summary via
  `getRideSummary()` and clears it via `clearRideSummary()` after a
  successful write, so it's used exactly once, on the next ride's recap.
- **The operator's own single-account step** (above) reads/clears their own
  summary the same way, keyed by the optional `CAPTAIN_TWITCH_ID` GitHub
  Actions secret — their app now uploads to the store under their own Twitch
  id just like everyone else's, instead of anything file-based.

**Retired mechanism:** this replaced committing `data/ride-summary.json` into
this repo via the GitHub Contents API (`GITHUB_CONTENT_PAT`) — user-submitted
data landing in the app's own source repo, behind a repo-content-write-scoped
PAT, was an anti-pattern this migration removes. `GITHUB_CONTENT_PAT` is no
longer read anywhere in this repo and can be deleted from both the relay's env
vars and the GitHub Actions secrets, along with the (now-unused)
`contents: write` workflow permission. If you're upgrading an existing deploy,
let the current workflow consume any pending `data/ride-summary.json` once
*before* deploying this change — it's the last thing that will ever read that
file — or port its contents into the store by hand
(`putRideSummary(<operator twitch id>, {...})`) if you can't wait for the next
ride.

`tools/relay-ride-summary.test.mjs` covers the endpoint against stubbed
Twitch/Upstash; `tools/per-user-recap.test.mjs` covers the fold-in/clear
behavior against a stubbed store.
