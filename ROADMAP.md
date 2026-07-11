# SlipstreamIRL Relay / Overlay — Roadmap

Relay (`server.js`) + overlay pages. Pairs with the **app** repo
(`slipstreamirl-app`), whose `ROADMAP.md` has the full project view.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Near-term

- [ ] **Normalize duplicate road names in Mapbox matching** — the same physical
      road can come back as two entries (e.g. "Moose-Wilson Road" and "Moose-Wilson
      Road (WY 390)") when Mapbox tags different stretches with slightly different
      strings, splitting the distance credit and eating two of the top-8 slots.
      Strip parenthetical highway suffixes before de-duping.
- [ ] **Remove the dead `/tiles/{z}/{x}/{y}.png` proxy** — leftover from the
      pre-MapLibre raster era; nothing references it anymore since the extension
      and overlays fetch OpenFreeMap's vector tiles directly.
- [ ] **Tune effort-zone band cutoffs** — multipliers in `karoo.html` (`zoneIndex`).
- [ ] **Wind: expose an mph option** at the source calculation, not just display.
- [ ] **Health/status page** showing connected overlays + last fix age.

## Big bet: multi-tenant relay (turnkey for many streamers — needs more thought)

Today the relay is single-tenant: one `RELAY_TOKEN`, one global room, global
`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/`lastRadar`/`lastPath`.
To host many streamers from one relay:

- [ ] **Channels keyed by Twitch user ID** — rooms per channel; overlays join via
      `?channel=<id>`; pushes target `?channel=<id>`. Move all cached "last*" state
      into per-channel objects.
- [ ] **Per-channel auth** — verify the streamer's Twitch token on first push (call
      Twitch `/users`), issue a signed per-channel push token (JWT). Overlays stay
      read-only/public by channel id (no secret in OBS URL).
- [ ] **Scaling** — Render always-on; if multi-instance, Redis pub/sub to share
      rooms across instances (WebSocket fan-out).

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

Messages the sender pushes via `POST /push?token=…`:

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
