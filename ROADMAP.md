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

## Later / ideas

- [ ] **Multiple overlay layouts** (map-only, stats bar, karoo embed) — already
      partly there (`/karoo`, `?embed`); make selectable/documented.
- [ ] **Stats on overlay** — speed + distance readout (data is already pushed).
- [ ] **Wind source/units** — open-meteo km/h today; expose mph option.
- [ ] **Health/status page** showing connected overlays + last fix age.

## Done (recent)

- [x] Marker glued to coordinates; stale `?` stays at last known location.
- [x] `goOffline` hides marker on `{offline:true}`.
- [x] `/push` accepts keyless control messages (`hidden`/`offline`/`wind`).
- [x] `broadcast` no longer rebuilds/drops control messages; `wind` state cached
      and sent to late-joining overlays.
- [x] Wind arrows: `?wind=off` URL default + live `{wind:bool}` toggle.

## Protocol notes (keep in sync with the app)

Messages the sender pushes via `POST /push?token=…`:

| message            | meaning                          | needs lat/lng |
|--------------------|----------------------------------|---------------|
| `{lat,lng,acc,hdg,spd,dist}` | normal position fix     | yes           |
| `{hidden:true}`    | inside privacy geofence          | no            |
| `{offline:true}`   | stream ended — hide marker       | no            |
| `{wind:bool}`      | wind arrows on/off               | no            |

**Any new keyless message must be allowed in BOTH `/push` validation and
`broadcast()`** — `broadcast()` rebuilds the payload, so unhandled fields are
silently dropped (this was a real bug).
