# IRL Stream Control

One free web service that:

- posts `!start` / `!stop` to your Twitch chat (your bot launches/stops OBS), and
- streams your phone’s GPS to a live map overlay for OBS.

No native app, no RTIRL. Phone → your relay → your overlay.

## Files

- `server.js` — the relay + serves the two pages
- `golive.html` — the control app (open on your phone) — served at `/`
- `overlay.html` — the OBS browser source — served at `/overlay`
- `render.yaml` — Render Blueprint (auto-provisions the service)
- `package.json` — deps + start command

## One-click deploy

Replace `YOUR_USERNAME/YOUR_REPO` with this repo, then click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/PeloTom89/OneClickStream.git)

This reads `render.yaml`, creates a free web service, and auto-generates the relay token.

## Setup (about 5 minutes)

1. **Create a Twitch app** at <https://dev.twitch.tv/console/apps> — type **Public**. Copy the **Client ID**.
1. **Push these files** to a GitHub repo.
1. **Click the Deploy button** above (or in Render: New → Blueprint → pick the repo).
- When prompted, paste your **Client ID** into the `TWITCH_CLIENT_ID` field.
- Render generates `RELAY_TOKEN` for you. Deploy.
1. **Copy your service URL** (e.g. `https://irl-stream-control.onrender.com`).
1. **Register the redirect** back on your Twitch app: add that URL **with a trailing slash** as an OAuth Redirect URL — it must match exactly.
1. **Go:** open the URL on your phone, tap Connect. In OBS, add a Browser source pointing at `<your-url>/overlay`.

## Notes

- **Cold start:** the free service sleeps after ~15 min idle (30–50s to wake) but stays up while you’re connected. Open the app and connect a minute before going live.
- **Privacy zone:** set `HOME` (lat/lng + radius in meters) in `golive.html` to stop broadcasting near home.
- **Token:** auto-generated and never committed, but it’s visible in the served page’s JS, so treat the control URL as private. Don’t share it publicly.
