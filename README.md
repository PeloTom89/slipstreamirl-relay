# SlipstreamIRL Relay

The backend web service for **SlipstreamIRL** — one small Node service (deploys on
Render, e.g. `irl-stream-control`) that relays your phone's GPS and bike-sensor data
to live OBS overlays, and proxies a few Twitch bits.

Phone (the [app](https://github.com/PeloTom89/slipstreamirl-app)) → this relay →
your OBS browser source. No RTIRL, no third-party location service.

## What it does

- Receives GPS, speed, distance, and BLE sensor data (power/cadence/heart rate)
  from the app over `POST /push`, and fans it out to connected overlays via WebSocket.
- Serves the overlay pages OBS points at.
- Bounces Twitch's OAuth redirect (`/app-redirect`) so the app can sign in.
- Proxies Twitch chat badge images for the chat overlay.

## Files & routes

| file | route | what |
|---|---|---|
| `server.js` | — | the relay (HTTP + WebSocket) |
| `golive.html` | `/` | legacy web control page |
| `overlay.html` | `/overlay` | map overlay (rider + wind), OBS browser source |
| `karoo.html` | `/karoo` | bike-computer overlay (speed, distance, 3s power, cadence, heart) |
| `chat.html` | `/chat` | Twitch chat overlay |
| `render.yaml` | — | Render Blueprint (auto-provisions the service + token) |

Endpoints: `POST /push` (sender), `GET /health` (token check), `GET /badges`
(chat badges), `GET /app-redirect` (Twitch OAuth bounce), WebSocket `?role=overlay|sender`.

## Overlay options

Both overlays take query params:
- `?embed=1` — fill flush (no rounded corners), used by the in-app preview / Karoo embed.
- `?wind=off` — start with wind arrows hidden (map overlay).
- `?units=metric` — start in metric (the app also sets units live).

`karoo.html` embeds `/overlay` for its map, so map fixes (smooth movement, marker,
wind) carry over. Card values color by effort zone when zones are enabled.

## Push protocol

The app pushes JSON to `POST /push?token=…`. Beyond a normal position fix, several
**keyless** control messages are supported (no lat/lng required):

| message | meaning |
|---|---|
| `{lat,lng,acc,hdg,spd,dist}` | position fix |
| `{hidden:true}` | inside the privacy geofence (overlay freezes to "?") |
| `{offline:true}` | stream ended — hide the marker |
| `{wind:bool}` | wind arrows on/off |
| `{units:"imperial"\|"metric"}` | units preference |
| `{power,cadence,hr}` | BLE sensor values |
| `{zones:{enabled,ftp,lthr,maxhr,cadence,speed}}` | effort-zone anchors |

`broadcast()` rebuilds each payload and caches the latest of each kind
(`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`), replaying them to
any overlay that connects later. **Any new keyless message must be allowed in both
`/push` validation and `broadcast()`, or it's silently dropped.**

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PeloTom89/slipstreamirl-relay.git)

1. Create a **Public** Twitch app at <https://dev.twitch.tv/console/apps>; copy the **Client ID**.
2. Click Deploy (or Render → New → Blueprint → this repo). Paste the Client ID into
   `TWITCH_CLIENT_ID`; Render generates `RELAY_TOKEN`. Deploy.
3. Copy your service URL (e.g. `https://irl-stream-control.onrender.com`).
4. On the Twitch app, add `<your-url>/app-redirect` as an OAuth Redirect URL (exact match).
5. In the app, enter the relay URL + token under **Relay Server**. In OBS, add a
   Browser Source for `<your-url>/overlay` and/or `<your-url>/karoo`.

### Env vars

- `TWITCH_CLIENT_ID` — your Twitch app Client ID.
- `RELAY_TOKEN` — shared secret the **sender** (app) must present; overlays are
  read-only and need no token.
- `CLIENT_SECRET` *(optional)* — enables chat badge images via Twitch Helix.

## Notes

- **Cold start:** the free Render tier sleeps after ~15 min idle (30–50s to wake).
  Connect a minute before going live.
- **Single-tenant:** today this is one streamer per relay (one token, one room).
  Multi-tenant (many streamers on one relay, keyed by Twitch ID) is in `ROADMAP.md`.
- The token is visible in the served control page's JS, so treat the relay URL as private.
