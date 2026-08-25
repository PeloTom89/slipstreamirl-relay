# SlipstreamIRL Relay / Overlay — Roadmap

Relay (`server.js`) + overlay pages. Pairs with the **app** repo
(`slipstreamirl-app`), whose `ROADMAP.md` has the full project view.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Near-term

- [ ] **Tune effort-zone band cutoffs** — multipliers in `karoo.html` (`zoneIndex`).
- [ ] **Wind: expose an mph option** at the source calculation, not just display.
- [ ] **Health/status page** showing connected overlays + last fix age.

## Big bet: multi-tenant relay (turnkey for many streamers)

Single-tenant behaviour (one `RELAY_TOKEN`, one global room) is still the
**default** — nothing below applies unless `MULTI_TENANT=1` is set. See
README.md "Multi-tenant mode" for the full contract (env vars, URL shape,
token model).

- [x] **Channels keyed by Twitch user ID** — rooms per channel; overlays join
      via `?channel=<id>`; pushes target `?channel=<id>`. All cached "last*"
      state (`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/
      `lastRadar`/`lastPath`/`delayMs`) plus the overlay `Set` moved into
      per-channel objects (`server.js`'s `channels` Map). Isolation between
      simultaneously-active channels, and per-channel late-join replay, are
      covered by `tools/relay-server.test.mjs`.
- [x] **Per-channel auth** — pushes are gated by a signed per-channel JWT
      (`tools/channel-token.js`; claims `{channel,iat,exp}`), checked against
      the request's `?channel=` on every `/push` and sender WebSocket.
      Overlays stay read-only/public by channel id (no secret in OBS URL).
      `POST /channel-token` now verifies the streamer's Twitch identity (calls
      Twitch `/users` with the caller's own access token) before issuing —
      see README.md "Stripe entitlement". `tools/mint-channel-token.js` (ops,
      manual) still works unchanged for channels run without Stripe wired up.
      **Still open:** wiring `/channel-token` into the app itself (app-side
      auto-provisioning) is a separate roadmap item, see the app repo's
      `ROADMAP.md`.
- [x] **Entitlement-gated renewal** — `POST /channel-token` refuses to issue
      unless a Stripe subscription is active (or within its grace period) for
      that Twitch id. Stripe is the sole source of truth (no durable local
      store — see README.md "Stripe entitlement" for why, given Render's free
      plan). Handles `customer.subscription.created/updated/deleted`,
      `invoice.payment_failed`, and `checkout.session.completed`; webhook
      signature verification is security-critical and covered by
      `tools/stripe-entitlement.test.mjs`
      and `tools/relay-entitlement.test.mjs`. Grace period
      (`ENTITLEMENT_GRACE_SECONDS`, default 3 days) is a placeholder default —
      **the captain still needs to confirm this value.** Never a live check on
      the hot `/push` path — checked only at token issuance.
      **Still open:** Discord as a second, OR'd entitlement source (explicitly
      out of scope of the change that added Stripe — see README.md "Discord
      (not built)").
- [x] **Beta allowlist** — `BETA_ALLOWLIST_TWITCH_IDS` (comma-separated Twitch
      ids) bypasses the *payment* check only, not identity verification, so
      the captain's TestFlight testers can use hosted mode without a Stripe
      subscription while it's still an internal beta. Empty/absent by
      default, only reachable when Stripe entitlement is otherwise configured,
      and visible (logged per token issuance, counted on the root status
      line) rather than a silent bypass — see README.md "Beta allowlist".
      **Still open:** clearing the list before hosted relay goes
      subscription-only for real is a manual step the captain has to
      remember; nothing in code expires or nags about it.
- [ ] **Scaling** — Render always-on; if multi-instance, Redis pub/sub to share
      rooms across instances (WebSocket fan-out). Still premature per the
      multi-tenant design doc's cost/scale analysis — single-instance covers
      friends-scale and well beyond.

See the app `ROADMAP.md` "Big bet" section for the full turnkey plan (app
auto-provisioning, distribution, privacy policy, phasing).

## Later / ideas

- [ ] **Landmark/POI enrichment for the Strava write-up — tried, partly kept.**
      Mapbox Tilequery for trailside points of interest (turnouts, trailheads) was
      built and shipped, then removed — results skewed toward condo buildings over
      anything worth mentioning. A second attempt at "prominent visible landmarks"
      (mountains, lakes) via a large-radius `natural_label` query was also removed:
      Tilequery always searches a small fixed tile neighborhood at the tileset's max
      zoom regardless of the `radius` parameter, so it structurally can't find a
      landmark that's genuinely far from the road (like a mountain that's merely
      *visible*). If revisited, the real fix is a small curated list of known
      landmarks (name + coordinates) checked by simple distance-to-route math, not
      another Tilequery variant. Real road-name matching (Map Matching, not
      Tilequery) works well and is kept.
- [ ] **Health/status page** (see Near-term).

## Done (recent)

- [x] **Stripe entitlement gating for channel-token issuance** — see the "Big
      bet" section above and README.md "Stripe entitlement" for the full
      design (why Stripe, not a local store, is the source of truth; the
      Twitch↔Stripe identity link; the grace-period model). Tested without
      live Stripe credentials, against fixtures shaped like Stripe's
      documented event/signature scheme (`tools/stripe-entitlement.test.mjs`,
      `tools/relay-entitlement.test.mjs`) — a few specifics (exact Payment
      Link Dashboard mechanics, real webhook delivery behavior) are flagged
      in README.md as unverified until the captain has a live account.
- [x] **Multi-tenant relay, opt-in mode** — see the "Big bet" section above and
      README.md "Multi-tenant mode". `broadcast()`/`emit()` now take an
      explicit `channel` state bundle instead of closing over module-level
      globals, specifically to avoid the class of bug called out below
      (a message reaching the wrong channel, or none, silently) when
      channelizing them. Single-tenant mode (the default) reuses the exact
      same code path against one fixed internal channel and ignores any
      `?channel=` a caller sends, which is what keeps its behaviour identical
      to before — verified by `tools/relay-server.test.mjs`, not just assumed.
- [x] **Removed the dead `/tiles/{z}/{x}/{y}.png` proxy** — confirmed nothing
      calls it: grepped this repo plus the sibling `slipstreamirl-extension`
      and `slipstreamirl-app` repos, and `/overlay-raster` (`overlay.html`)
      fetches OpenStreetMap tiles directly rather than through this proxy. The
      extension's `overlay.js` had a stray comment referencing a relay tile
      proxy, but its actual code fetches OpenFreeMap vector tiles directly —
      the comment was already stale, not a live dependency.
- [x] **Normalize duplicate road names in Mapbox matching** — the same physical
      road could come back as two entries (e.g. "Moose-Wilson Road" and
      "Moose-Wilson Road (WY 390)") when Mapbox tagged different stretches with
      slightly different strings, splitting the distance credit and eating two
      of the top-8 slots. `tools/road-names.mjs` strips a trailing
      highway/route parenthetical for grouping only (the reader still sees the
      clean, shorter variant), sums distance across merged variants, and keeps
      the top-8 selection in ride order. Deliberately conservative: a
      parenthetical with no route-like digits, or names that merely share a
      prefix with no parenthetical at all (e.g. "Main Street" vs "Main Street
      North"), are left as separate roads rather than risk a wrong merge. See
      `tools/road-names.test.mjs` (`npm test`).
- [x] **MapLibre vector map migration** — `/overlay` now serves the vector map
      (`overlay-gl.html`, OpenFreeMap tiles); street/landmark labels stay upright
      through course-up rotation, unlike the old raster tiles. Raster kept as a
      fallback at `/overlay-raster`.
- [x] **GPS smoothing** — adaptive `easeTo` duration keyed to the real gap between
      fixes, so the rider glides continuously instead of stalling/lurching between
      updates.
- [x] **Breadcrumb trail** — relay caches the whole ride path server-side and
      replays it to late-joining/refreshed overlays, not just the trail since they
      connected.
- [x] **Garmin Varia radar strip** on `/overlay`.
- [x] **Course-up map rotation** by default (`?north=1` for north-up).
- [x] **Twitch Extension shipped** — MapLibre-ported video overlay in a separate
      `slipstreamirl-extension` repo, synced into `/ext` for the app's in-app
      Extension preview tab.
- [x] **Strava/YouTube auto-post GitHub Action** — scheduled job that finds the
      matching YouTube upload + Strava activity and writes an AI-generated
      title/description from ride stats, popularity-ranked segments, real
      GPS-matched road names (Mapbox, optional), and the rider's dictated notes.
      Ships with `dry_run`/`manual_apply`/`list_recent` testing modes so nothing
      real gets touched by accident.
- [x] **Wind arrows** — real-world zoom/latitude-scaled speed (amplified for
      visibility) instead of an arbitrary visual rate.
- [x] **Configurable broadcast delay** to sync overlay data with the stream's
      real-world latency.
- [x] **Karoo bike-computer cards** — speed, distance, 3s power, cadence, heart;
      speedometer icon for speed, lightning for power.
- [x] **Effort-zone colors** — value digits tint green→purple from `{zones}`
      anchors (FTP, LTHR+maxHR, avg cadence, fast speed).
- [x] **Units** — live `{units}` message + `?units` default; Karoo + map honor it.
- [x] Marker glued to coordinates; stale `?` stays at last known location.
- [x] `goOffline` hides marker on `{offline:true}`.
- [x] `broadcast` no longer drops control messages; all persistent state
      (wind/units/sensors/zones/location/radar/path) cached + replayed to late overlays.

## Protocol notes (keep in sync with the app)

Messages the sender pushes via `POST /push?token=…` (multi-tenant mode:
`POST /push?channel=<id>&token=<channel JWT>` — see README.md "Multi-tenant
mode"; every message below is routed and cached per-channel in that mode):

| message                       | meaning                       | needs lat/lng |
|-------------------------------|-------------------------------|---------------|
| `{lat,lng,acc,hdg,spd,dist}`  | normal position fix           | yes           |
| `{hidden:true}`               | inside privacy geofence       | no            |
| `{offline:true}`              | stream ended — hide marker    | no            |
| `{wind:bool}`                 | wind arrows on/off            | no            |
| `{units:"imperial"\|"metric"}`| units preference              | no            |
| `{power,cadence,hr}`          | BLE sensor values             | no            |
| `{zones:{ftp,lthr,maxhr,cadence,speed}}` | effort-zone anchors| no            |
| `{radar:[...]}`               | Garmin Varia radar targets    | no            |
| `{path:[[lat,lng],...]}`      | full breadcrumb-trail replay  | no            |
| `{liveStart}`                 | go-live timestamp (elapsed timer) | no        |
| `{delay:<seconds>}`           | broadcast delay                | no           |

**Any new keyless message must be allowed in BOTH `/push` validation and
`broadcast()`** — `broadcast()` rebuilds the payload, so unhandled fields are
silently dropped (this was a real bug). Persistent state is cached
(`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/`lastLocation`/`lastRadar`/`lastPath`)
and replayed on overlay connect.

In multi-tenant mode this same hazard applies to *which channel* a message
reaches, not just whether it's dropped — see AGENTS.md.
