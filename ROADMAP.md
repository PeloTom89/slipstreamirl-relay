# SlipstreamIRL Relay / Overlay — Roadmap

Relay (`server.js`) + overlay pages. Pairs with the **app** repo
(`slipstreamirl-app`), whose `ROADMAP.md` has the full project view.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Near-term

- [ ] **Auto-deploy confirmation** — verify Render redeploys `main` on push;
      document the service name/branch in the README.
- [ ] **Last-state replay audit** — new overlays receive `lastWind` + `lastLocation`
      on connect. Confirm `offline` is reflected (cleared `lastLocation`) so a
      late-joining overlay doesn't snap to a stale position.

## Big bet: multi-tenant relay (turnkey for many streamers — needs more thought)

Today the relay is single-tenant: one `RELAY_TOKEN`, one global room, global
`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`. To host many
streamers from one relay:

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

- [ ] **Karoo as a Twitch Extension** — package `karoo.html` as a Video Overlay
      extension (config + video_overlay pages, `twitch-ext.js`, relay URL in ext
      config, tokenless read-only overlay role). Relay is already HTTPS.
- [ ] **Tune effort-zone band cutoffs** — multipliers in `karoo.html` (`zoneIndex`).
- [ ] **Wind source/units** — open-meteo km/h today; expose mph option.
- [ ] **Health/status page** showing connected overlays + last fix age.

## Done (recent)

- [x] **Karoo bike-computer cards** — speed, distance, 3s power, cadence, heart;
      speedometer icon for speed, lightning for power.
- [x] **Effort-zone colors** — value digits tint green→purple from `{zones}`
      anchors (FTP, LTHR+maxHR, avg cadence, fast speed).
- [x] **Units** — live `{units}` message + `?units` default; Karoo + map honor it.
- [x] Marker glued to coordinates; stale `?` stays at last known location.
- [x] `goOffline` hides marker on `{offline:true}`.
- [x] `broadcast` no longer drops control messages; all persistent state
      (wind/units/sensors/zones/location) cached + replayed to late overlays.

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

**Any new keyless message must be allowed in BOTH `/push` validation and
`broadcast()`** — `broadcast()` rebuilds the payload, so unhandled fields are
silently dropped (this was a real bug). Persistent state is cached
(`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/`lastLocation`) and replayed on
overlay connect.
