# SlipstreamIRL Relay

The backend for **SlipstreamIRL** — a small Node service (deploys on Render, e.g.
`irl-stream-control`) that relays your phone's GPS and bike-sensor data to live OBS
overlays, serves a Twitch Extension preview, and runs a scheduled job that
auto-links each ride's YouTube VOD (with an AI-written title/description) back to
Strava.

Phone (the [app](https://github.com/PeloTom89/slipstreamirl-app)) → this relay →
your OBS browser source. No RTIRL, no third-party location service.

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
  and parking a dictated **Voice Ride Summary** for the Strava workflow below.
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
| `.github/workflows/strava-youtube-comment.yml` | — | scheduled job, see **Strava/YouTube auto-post** below |
| `render.yaml` | — | Render Blueprint (auto-provisions the service + token) |

Endpoints: `POST /push` (sender), `GET /health` (token check), `GET /badges`
(chat badges), `GET /app-redirect` (Twitch OAuth bounce), `POST /ai/twitch-title`
(Claude ride-plan → title), `POST /ride-summary` (parks a dictated post-ride
summary for the workflow below), `POST /channel-token` (entitlement-gated
channel push token issuance, multi-tenant mode), `POST /stripe-webhook`
(Stripe entitlement events, multi-tenant mode), WebSocket `?role=overlay|sender`.

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

Off by default — every free/BYO deploy and the captain's own existing deployment
keep working exactly as documented above, with no config change. This is an
**opt-in mode of the same `server.js`**, not a fork, for hosting many streamers'
rooms from one relay instance (the paid/turnkey tier). See `ROADMAP.md` for the
product context.

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

- **Automatic, entitlement-gated (`POST /channel-token`)** — see **Stripe
  entitlement** below. This is the path a real paying customer's app should
  use, and it only issues a token to someone with an active (or recently
  active, see grace period) Stripe subscription.
- **Manual (ops tool, unaffected)** — for the friends-scale phase, or any
  channel you want to run without wiring up Stripe at all:
  ```
  RELAY_JWT_SECRET=... node tools/mint-channel-token.js <channelId> [ttlSeconds]
  ```
  `/channel-token` deliberately falls back to unavailable (503) rather than
  issuing anything when `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` aren't
  both set — this tool keeps working exactly as before in that case.

The `exp` claim is what makes entitlement expiry-based rather than a live
per-push billing check — see **Stripe entitlement** below for why that
matters.

**Not in scope of this mode:** Redis, multi-instance fan-out, or any
horizontal scaling — a single instance handles far more load than this will
see at friends-scale. Ride data is still never persisted to disk in this mode
either — per-channel state is in-memory only, same privacy property as
single-tenant mode (see **Notes** below). The entitlement cache added below
lives in its own separate in-memory `Map`, keyed by Twitch id — it never
touches, and is never touched by, the per-channel ride-state `Map`, so adding
billing state hasn't made ride data durable as a side effect.

## Stripe entitlement

Gates `POST /channel-token` (above) on a paying Stripe subscription. Opt-in,
on top of multi-tenant mode: unset `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`
and this whole feature is inert — `/channel-token` just answers 503 and
manual minting keeps working, same as before this existed.

### The design question: where does "who has paid" live?

This relay deploys on **Render's Free plan** (`render.yaml`): ephemeral
filesystem, sleeps after ~15 minutes idle. A local file, or a plain in-memory
map with nothing behind it, would silently un-entitle every paying customer
on the next restart or sleep — the worst possible bug for this feature to
have, and one that would fail completely silently.

**Chosen: Stripe is the sole source of truth, with an in-memory cache that
Stripe itself can always rebuild.** No durable local store exists, or is
needed, for either subscription status or the Twitch↔Stripe identity link —
**with one narrow, deliberate exception**, explained below:

- The identity link (which Stripe customer is which Twitch streamer) lives in
  **Stripe's own `metadata.twitch_id`** on the Subscription — not in anything
  this relay stores. Almost everything this code does is a read: it never
  creates a Customer, Subscription, Price, Product, or Payment Link, and it
  never touches billing/status. The one exception is `metadata.twitch_id`
  itself — see **Identity linking** below for why a write turned out to be
  required here, and **What the write can and cannot do** for how narrowly
  it's scoped.
- A short-lived in-memory cache (`tools/stripe-entitlement.js`), keyed by
  Twitch id, is kept warm by webhooks so the common case — a streamer whose
  process already knows about them — needs no network call.
- On a **cache miss** (a Twitch id this process has never seen — e.g. right
  after a Render sleep/restart, when the in-memory cache is empty by
  construction — or an entry that's aged past its grace window), the relay
  reconciles with **one read-only Stripe Search API call**
  (`GET /v1/subscriptions/search?query=metadata['twitch_id']:'<id>'`). This is
  what makes a restart harmless: nothing durable was ever needed *in this
  relay*, because Stripe already durably holds both the identity link and the
  subscription status — precisely because the identity link is durably
  written into Stripe the moment it's known (see below), not left to an
  in-memory cache that a restart would erase.

This was evaluated against the two alternatives named in the design brief:
a **local durable store** was rejected because it requires infrastructure
the captain hasn't authorized or provisioned (Render's free plan has none);
a pure **"always query Stripe" model** and a **"webhook cache + reconciliation
on miss" model** turn out to be the same thing here, because there's no
separate identity table to keep in sync — Stripe's metadata search doubles as
that table. The cost accepted: an API call on the token-renewal path (not the
hot GPS-push path — see below), and a soft dependency on Stripe being
reachable (see **What happens if Stripe is unreachable**).

**The hot path is untouched.** `POST /push` (every ~3s while riding) never
calls Stripe, never checks entitlement, and never even looks at the
entitlement cache — it only checks the existing per-channel JWT's signature
and expiry, exactly as before. Entitlement is checked **once, at token
issuance/renewal** (`POST /channel-token`, expected ~daily per streamer, not
per GPS fix). A lapsed subscription means *the next token isn't issued* —
never "this ride's connection gets torn down." An already-issued token keeps
working for its full lifetime (currently ~1 day, `tools/channel-token.js`'s
default TTL) regardless of what happens to the subscription in the meantime.

### Identity linking: Stripe customer ↔ Twitch id

**What the relay expects:** somewhere on the Stripe object a webhook event
carries — the Subscription, or (fallback) the Customer it belongs to — a
`metadata.twitch_id` key holding the streamer's Twitch user id. The relay
checks, in order: (1) `metadata.twitch_id` directly on the event's object,
(2) `client_reference_id` on a `checkout.session.completed` event, (3) a
lookup of the Customer's own `metadata.twitch_id` (for events, mainly
Invoices, whose object has no metadata of its own but does have a `customer`
id).

**Path (2) needed a write, and here's why.** `client_reference_id` exists
only on the Checkout Session object — it is never copied onto the
Subscription by Stripe itself, and a Session isn't something `reconcile()`
can re-query later (there is no "search Checkout Sessions by
client_reference_id" that stays valid after the session is gone). Earlier
versions of this code read `client_reference_id` off
`checkout.session.completed` and then **silently discarded it** — there was
no case for that event type in the webhook handler, so the id that had just
been resolved went nowhere, no cache entry was ever written, and
`reconcile()` had nothing to find on a later restart. A Payment Link using
`client_reference_id` never entitled anyone, silently, until this was fixed.

**The fix:** `applyStripeEvent()` now handles `checkout.session.completed`.
When the id came from `client_reference_id` (i.e. the Session has no
`metadata.twitch_id` of its own — see path (1)/(3) below for when it does),
the relay makes **one write**: `POST /v1/subscriptions/:id` with
`metadata[twitch_id]=<id>`, copying the identity link onto the Subscription
that Checkout just created. That single write is what makes the link durable
in **Stripe**, which is exactly this design's own stated principle (Stripe
is the sole source of truth) — it does not introduce any local durable
state, and every later lookup (webhooks and `reconcile()`'s search) reads
the same field it always did.

**What the write can and cannot do.** `createSubscriptionMetadataWriter()`
(`tools/stripe-entitlement.js`) is the only function in this module that
performs a Stripe write, and it is invoked from exactly one call site: the
`checkout.session.completed` case, only when `client_reference_id` is the
identity source and the Session carries a `subscription` id. It sets exactly
one metadata key on exactly the Subscription named by that id — the update-a-
subscription endpoint cannot create, cancel, refund, or change price/status
on anything, so this cannot be induced into a money-moving or destructive
call regardless of what a forged/malformed event might contain (the event
itself is still signature-verified before any of this runs — see **Stripe
webhook**). If the write fails (Stripe unreachable, bad response), the
failure is swallowed the same way every other soft-failure in this module
is: no retry loop, and the subscriber simply isn't entitled until something
else re-triggers this same code path (support fallback:
`tools/mint-channel-token.js`).

**Because of this write, `STRIPE_SECRET_KEY` is no longer read-only** — see
**Env vars** below.

**What the captain needs to set up in Stripe (not built by this change — see
"Explicitly out of scope"):** when creating the Payment Link (or Checkout
Session) customers use to subscribe, attach the subscriber's Twitch id
either as `metadata.twitch_id` on the resulting Subscription/Customer, or as
`client_reference_id` on the Checkout Session. Two ways to do this, in order
of how little code they need:

1. **No-code, if your Payment Link supports it:** add a required Custom
   Field (e.g. "Twitch username or ID") to the Payment Link, then reference
   it in the Payment Link's own metadata using Stripe's `{{custom_field_key}}`
   templating syntax, so the field's answer is copied into
   `metadata.twitch_id` automatically. **Confirm this exact mechanism in your
   live Stripe Dashboard before relying on it** — this could not be verified
   without a real account, per this task's constraints (no Stripe account
   was created, no live Dashboard was used). If you use this path, the relay
   never needs to write anything — the identity link is already durable in
   Stripe by the time any webhook fires.
2. **`client_reference_id` as a query parameter** on the Payment Link URL
   (`?client_reference_id=<twitch_id>`), which Stripe does copy onto the
   resulting Checkout Session — confirmed against a real Stripe test account.
   This requires whatever page constructs that URL to already know the
   subscriber's Twitch id (out of scope of this change — no purchase/checkout
   page was built here), but no longer requires any Dashboard templating
   setup, and — as of this change — the relay durably persists the link onto
   the Subscription itself the moment Checkout completes, via the write
   described above.

Either way, this is genuinely the fiddliest part of this feature and the
part most likely to need iteration once real Stripe checkout is live — this
code accepts the identity signal from any of the three lookup paths above
specifically so it isn't locked into one exact Dashboard mechanism.

### Events handled

| Stripe event | Effect |
|---|---|
| `customer.subscription.created` | Entitles through `current_period_end` + grace, if `status` is `active`/`trialing` |
| `customer.subscription.updated` | Same as above if entitling; otherwise treated as a lapse (e.g. `past_due`, `unpaid`, `canceled`) |
| `customer.subscription.deleted` | Lapse — grace period starts now |
| `invoice.payment_failed` | Lapse — grace period starts now |
| `checkout.session.completed` | No entitlement effect by itself — writes `metadata.twitch_id` onto the new Subscription if `client_reference_id` is the identity source (see **Identity linking** above); the following `customer.subscription.created` grants entitlement as usual |

A "lapse" never *extends* entitlement past what an active subscription
already had — it only caps it at `now + grace`, so a mid-period cancellation
doesn't accidentally grant the rest of that period. A lapse for a Twitch id
this process has never seen still opens a fresh grace window rather than
denying outright — deliberately favoring a false *allow* (a few extra days of
service) over a false *deny* (a customer's stream cut off), per the design
brief's stated priority.

`invoice.paid`/`customer.subscription.trial_will_end` and other Stripe events
are received but ignored — `customer.subscription.updated` already fires on
renewal (period-end change with `status` staying `active`), so a dedicated
`invoice.paid` handler was judged redundant. **This assumption could not be
verified against a live Stripe account's actual event stream** — worth
confirming once real checkout traffic exists.

### What happens if Stripe is unreachable

Only affects `POST /channel-token` (renewal), never a live ride. If that
Twitch id has ever been positively confirmed entitled before (even if that's
since lapsed past its grace window), the relay trusts that rather than
guessing — a transient Stripe outage shouldn't cut off someone who was
already a known subscriber. If the Twitch id has never been seen at all, or
has only ever been confirmed NOT entitled, the request is refused (403 "not
entitled") rather than inventing an answer.

### Grace period

**`ENTITLEMENT_GRACE_SECONDS`** — defaults to **3 days (259200)**. **This
default is not the captain's confirmed choice — it needs his sign-off.** Err
generous per the design brief: a false allow costs a few days of service, a
false deny costs a customer's stream. Raise it if that tradeoff feels too
tight; Stripe's own dunning/retry window (configurable in the Stripe
Dashboard, separate from this setting) can already run several days on its
own before a subscription flips to `past_due`/`unpaid`, so this grace period
stacks on top of whatever Stripe's own retries already bought.

### Env vars

- `STRIPE_SECRET_KEY` — Stripe secret API key. Used mostly for read calls
  (`GET /v1/subscriptions/search`, `GET /v1/customers/:id`), plus **one
  narrowly-scoped write**: `POST /v1/subscriptions/:id` to set
  `metadata.twitch_id`, only from the `checkout.session.completed` handler,
  only when `client_reference_id` is the identity source — see **Identity
  linking** above for why, and exactly what that write can and cannot touch.
- `STRIPE_WEBHOOK_SECRET` — the signing secret Stripe shows when you register
  the webhook endpoint (below). Required to verify `Stripe-Signature` —
  **without this, the endpoint would accept a forged event from anyone**, so
  both this and `STRIPE_SECRET_KEY` must be set together or entitlement stays
  off.
- `ENTITLEMENT_GRACE_SECONDS` *(optional, default `259200` = 3 days)* — see
  above.

Both are unset on every free/BYO deploy and on the captain's own deployment
until he opts in — this is purely additive to multi-tenant mode.

### What the captain needs to create in Stripe (not done by this change)

Per this task's scope, **no Stripe account, product, price, Payment Link,
webhook, or customer was created or modified** — only the relay code that
consumes them. Before this works end-to-end, the captain needs to:

1. Create the subscription Product/Price and a Payment Link (or hosted
   Checkout) in the Stripe Dashboard — the relay never cares what the price is.
2. Configure that Payment Link/Checkout to attach `metadata.twitch_id` to the
   resulting Subscription or Customer — see **Identity linking** above.
3. Register a webhook endpoint at `https://<your-relay-url>/stripe-webhook`,
   subscribed to at least: `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `checkout.session.completed` (this last one is
   what carries `client_reference_id` — see **Identity linking** — omitting
   it means that identity path never works). Copy the signing secret Stripe
   shows into `STRIPE_WEBHOOK_SECRET`.

   > **⚠️ The URL must end in `/stripe-webhook`, not the bare root.** The
   > relay's root path is its status page, which returns `200 OK` to any
   > request — including Stripe's. Point the endpoint at the root by mistake
   > and Stripe will report every delivery as successful (`pending_webhooks`
   > stays 0, no retries queued, dashboard looks healthy) while the relay
   > processes nothing and entitlement silently never works, with no error
   > surfaced anywhere. This is a real incident that happened while wiring up
   > a live test account, not a hypothetical.
   >
   > To confirm the endpoint is right, send it an unsigned request: a correctly
   > configured `/stripe-webhook` endpoint **rejects** it with `400 bad
   > signature`. A misrouted endpoint pointed at the root instead returns `200`
   > and the relay's status text. That difference is the reliable way to tell
   > them apart, and it's been verified live against the deployed service.
4. Set `STRIPE_SECRET_KEY` to a **secret** (not publishable) API key.
5. Confirm the grace period default above, and the identity-linking mechanism
   in (2) against your live Dashboard — both are flagged in this README as
   unverified without a real Stripe account.

### What could not be verified without a live Stripe account

- Whether the exact no-code "Custom Field → `{{template}}` → subscription
  metadata" mechanism described under **Identity linking** is available for
  every Payment Link type in the current Stripe Dashboard.
- Whether `customer.subscription.updated` reliably fires on every renewal in
  practice (assumed here, based on Stripe's documented webhook model, but not
  observed against a real event stream).
- Real-world webhook delivery latency/retries, and how Stripe's own dunning
  schedule (Dashboard-configured) interacts with this relay's independent
  grace period in practice.
- The `POST /v1/subscriptions/:id` metadata write itself (`checkout.session.completed`
  → `createSubscriptionMetadataWriter`) is implemented per Stripe's documented
  API and covered by this repo's tests against a stub Stripe, but has not
  been exercised against a live Stripe account within this change.

### Discord (not built)

The entitlement store's `isEntitled()` check is structured so a second
source could be OR'd in later (any source that can say "entitled until
timestamp X" for a Twitch id) without changing the token-issuance code path
or the JWT format — but no Discord integration exists, per this task's scope.

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
| `rider_notes_override` | simulate with arbitrary ride notes (the real dictated file is usually already consumed by the time you want to preview) |
| `activity_id_override` | target a specific activity instead of whatever's "latest" |
| `title_override` + `opener_override` | skip Claude and apply this exact reviewed text to the activity (replaces the description instead of appending) |
| `list_recent` | logs your 10 most recent activity ids/names/dates — no Claude/Mapbox calls, no YouTube check |

### GitHub Actions secrets (separate from the Render env vars below)

`YOUTUBE_API_KEY`, `YOUTUBE_CHANNEL_ID`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`,
`STRAVA_REFRESH_TOKEN`, `ANTHROPIC_API_KEY` (required); `MAPBOX_TOKEN` (optional —
enables real road-name matching); `YOUTUBE_OAUTH_CLIENT_ID` /
`YOUTUBE_OAUTH_CLIENT_SECRET` / `YOUTUBE_OAUTH_REFRESH_TOKEN` (optional — mirrors
the description onto the YouTube video too).

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PeloTom89/slipstreamirl-relay.git)

1. Create a **Public** Twitch app at <https://dev.twitch.tv/console/apps>; copy the **Client ID**.
2. Click Deploy (or Render → New → Blueprint → this repo). Paste the Client ID into
   `TWITCH_CLIENT_ID`; Render generates `RELAY_TOKEN`. Deploy.
3. Copy your service URL (e.g. `https://irl-stream-control.onrender.com`).
4. On the Twitch app, add `<your-url>/app-redirect` as an OAuth Redirect URL (exact match).
5. In the app, enter the relay URL + token under **Relay Server**. In OBS, add a
   Browser Source for `<your-url>/overlay` and/or `<your-url>/karoo`.

### Render env vars (the always-on service)

- `TWITCH_CLIENT_ID` — your Twitch app Client ID.
- `RELAY_TOKEN` — shared secret the **sender** (app) must present; overlays are
  read-only and need no token.
- `CLIENT_SECRET` *(optional)* — enables chat badge images via Twitch Helix.
- `ANTHROPIC_API_KEY` *(optional)* — enables the Voice Ride Plan title-generation
  endpoint (`/ai/twitch-title`).
- `GITHUB_CONTENT_PAT` *(optional)* — lets `/ride-summary` commit a dictated
  post-ride summary into this repo via the GitHub Contents API, for the Strava
  workflow above to pick up.
- `MULTI_TENANT` / `RELAY_JWT_SECRET` *(optional)* — enable multi-tenant mode.
  See **Multi-tenant mode** above; unset on every free/BYO deploy.
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `ENTITLEMENT_GRACE_SECONDS`
  *(optional, multi-tenant mode only)* — enable Stripe-backed entitlement
  gating on channel-token issuance. See **Stripe entitlement** above; unset
  on every free/BYO deploy and until the captain opts in.

## Notes

- **Cold start:** the free Render tier sleeps after ~15 min idle (30–50s to wake).
  Connect a minute before going live.
- **Single-tenant by default:** one streamer per relay (one token, one room) —
  every free/BYO deploy, unchanged. **Multi-tenant mode** (above) is an opt-in
  flag on this same `server.js` for hosting many streamers on one relay,
  keyed by Twitch ID, with Twitch-identity-verified, Stripe-entitlement-gated
  token issuance (**Stripe entitlement** above); remaining work (app-side
  auto-provisioning, Discord as a second entitlement source) is in `ROADMAP.md`.
- The token is visible in the served control page's JS, so treat the relay URL as private.
