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
| `.github/workflows/strava-youtube-comment.yml` | — | scheduled job, see **Strava/YouTube auto-post** below |
| `render.yaml` | — | Render Blueprint (auto-provisions the service + token) |

Endpoints: `POST /push` (sender), `GET /health` (token check), `GET /badges`
(chat badges), `GET /app-redirect` (Twitch OAuth bounce), `POST /ai/twitch-title`
(Claude ride-plan → title), `POST /ride-summary` (parks a dictated post-ride
summary for the workflow below), WebSocket `?role=overlay|sender`.

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
| `{radar:[...]}` | Garmin Varia radar targets |
| `{path:[[lat,lng],...]}` | full breadcrumb-trail replay for late-joining overlays |
| `{liveStart}` | go-live timestamp, for the overlay's elapsed timer |
| `{delay:<seconds>}` | broadcast delay, to sync overlay data with the stream's real-world latency |

`broadcast()` rebuilds each payload and caches the latest of each kind
(`lastLocation`/`lastWind`/`lastUnits`/`lastSensors`/`lastZones`/`lastRadar`/`lastPath`),
replaying them to any overlay that connects later. **Any new keyless message must be
allowed in both `/push` validation and `broadcast()`, or it's silently dropped.**

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

## Notes

- **Cold start:** the free Render tier sleeps after ~15 min idle (30–50s to wake).
  Connect a minute before going live.
- **Single-tenant:** today this is one streamer per relay (one token, one room).
  Multi-tenant (many streamers on one relay, keyed by Twitch ID) is in `ROADMAP.md`.
- The token is visible in the served control page's JS, so treat the relay URL as private.
