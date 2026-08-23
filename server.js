// server.js — tiny location relay (your "custom web service")
//
// One sender (your phone) pushes { lat, lng }; any number of overlays receive it.
// Run:  npm install ws   then   node server.js
// Host it anywhere that runs Node and gives you HTTPS/WSS (Render, Railway, Fly.io,
// or your own VPS behind Caddy/nginx). WSS is required because your pages are HTTPS.
//
// Env vars:
//   PORT         (set automatically by most hosts; defaults to 8080)
//   RELAY_TOKEN  shared secret the SENDER must present; overlays are read-only
//   MULTI_TENANT opt-in multi-tenant mode (see below) — unset/falsy by default,
//                which is the single-tenant behaviour above, unchanged.
//   RELAY_JWT_SECRET  required when MULTI_TENANT is on; signs/verifies the
//                per-channel push tokens (see tools/channel-token.js).
//
// Multi-tenant mode (MULTI_TENANT=1): the relay hosts many streamers' rooms
// instead of one. State, rooms, and push auth all become per-channel, keyed by
// `?channel=<id>` (the streamer's Twitch user id) — see README.md and
// ROADMAP.md for the full contract. Off by default so a bare `RELAY_TOKEN`
// deploy (every free/BYO relay, and the captain's own deployment unless it
// opts in) behaves exactly as it always has.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { verifyChannelToken } = require("./tools/channel-token.js");

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.RELAY_TOKEN || "change-me";
const MULTI_TENANT = /^(1|true|yes)$/i.test(process.env.MULTI_TENANT || "");
const JWT_SECRET = process.env.RELAY_JWT_SECRET || "";
if (MULTI_TENANT && !JWT_SECRET) {
  console.error("MULTI_TENANT=1 requires RELAY_JWT_SECRET to be set — refusing to start.");
  process.exit(1);
}
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || ""; // login app (public) — user OAuth
// Badge lookups use a Twitch app token (client credentials), which requires a
// CONFIDENTIAL app. The public login app can't have a secret, so this is a
// separate app: its Client ID + Secret below. Falls back to the login app's ID.
const BADGE_CLIENT_ID = process.env.TWITCH_BADGE_CLIENT_ID || CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";

// AI features (voice ride plan → Twitch title) — calls Claude directly; the key
// never leaves the server.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
// Ride-summary bridge: the relay has no persistent storage of its own (Render's
// free tier resets in-memory state on every sleep/restart), so a voice-dictated
// post-ride summary is committed to this repo via the GitHub Contents API and
// picked up later by the Strava/YouTube GitHub Actions workflow.
const GITHUB_CONTENT_PAT = process.env.GITHUB_CONTENT_PAT || "";
const GITHUB_REPO = "PeloTom89/slipstreamirl-relay";
const RIDE_SUMMARY_PATH = "data/ride-summary.json";

const TWITCH_TITLE_PROMPT = [
  "Write a Twitch stream title for a cycling livestream, based on the rider's spoken plan for today's ride.",
  "",
  "Style rules:",
  "- Punchier and more direct than a quiet personal log — this needs to catch attention in Twitch's browse feed.",
  "- Name the actual plan: the route, the goal, or the effort, using specifics from what the rider said.",
  "- No clickbait, no ALL CAPS, no excessive punctuation, no hashtags, no emoji spam (one emoji is fine, not required).",
  "- Keep it under 140 characters (Twitch's hard limit).",
  "- No quotation marks in the output.",
  "",
  "Good example: \"Chasing sunrise up Moose-Wilson Road 🚴\"",
  "Bad example (too flat/generic): \"Cycling stream\"",
  "Bad example (too much hype): \"INSANE 50 MILE RIDE!!! YOU WON'T BELIEVE THIS 🔥🔥🔥\"",
].join("\n");

// Overlay pages served straight from this service (one deploy / one URL).
// Control is the native SlipstreamIRL app now; "/" just returns a status line.
const PAGES = {
  "/overlay": "overlay-gl.html",      // MapLibre vector (upright labels on rotation)
  "/overlay-gl": "overlay-gl.html",   // alias kept during the migration
  "/overlay-raster": "overlay.html",  // old Leaflet raster overlay, kept as a fallback
  "/chat": "chat.html",
  "/karoo": "karoo.html",
};

// broadcast()/emit() take an explicit `channel` state bundle (see getChannel()
// below) rather than closing over module-level state — this is the one thing
// this codebase has already gotten wrong once (README.md/ROADMAP.md: "Any new
// keyless message must be allowed in both /push validation and broadcast(),
// or it's silently dropped"). In single-tenant mode `channel` is always the
// one `defaultChannel` bundle, which is what makes that mode's behaviour
// identical to before this function took a channel argument at all.
function broadcast(channel, loc) {
  // Broadcast-delay config from the app: {delay:<seconds>}. Apply it immediately
  // (the config message itself is never delayed) and don't forward it to overlays.
  if (typeof loc.delay === "number") {
    channel.delayMs = Math.max(0, Math.min(30000, Math.round(loc.delay * 1000)));
    return;
  }
  // Hold every overlay-bound message for delayMs so the data lines up with the
  // latency-delayed Twitch video. Cache state is mutated inside emit() (i.e. at
  // send time, post-delay), so a freshly-connected overlay snaps to whatever the
  // other overlays are currently showing rather than to the un-delayed "now".
  if (channel.delayMs > 0) setTimeout(() => emit(channel, loc), channel.delayMs);
  else emit(channel, loc);
}

// Approx distance in metres between two [lat,lng] points (for breadcrumb decimation).
const TRAIL_MIN_M = 25;    // only record a breadcrumb point after moving this far
const TRAIL_MAX = 8000;    // cap the cached path (~200 km / ~125 mi at 25 m spacing)
function distM(a, b) {
  const R = 6371000, dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  const lat = (a[0] + b[0]) / 2 * Math.PI / 180, x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

function emit(channel, loc) {
  let payload;
  if (loc.offline) {
    // Stream stopped — clear the cached position, ride start and breadcrumb path so
    // new overlays start fresh.
    channel.lastLocation = null;
    channel.lastLiveStart = null;
    channel.lastRadar = null;
    channel.lastPath = [];
    payload = JSON.stringify({ offline: true, ts: Date.now() });
  } else if (Array.isArray(loc.radar)) {
    // Garmin Varia radar targets [{speed,dist,threat}] — cache the latest frame for
    // late overlays (an empty array clears the strip when the road is clear).
    channel.lastRadar = loc.radar;
    payload = JSON.stringify({ radar: loc.radar, ts: Date.now() });
  } else if (typeof loc.liveStart === "number") {
    // Go-live timestamp (epoch ms) — cache so the elapsed timer is anchored to when
    // the rider actually went live, surviving overlay refreshes and late joins.
    channel.lastLiveStart = loc.liveStart || null;
    payload = JSON.stringify({ liveStart: channel.lastLiveStart, ts: Date.now() });
  } else if (typeof loc.wind === "boolean") {
    // Wind on/off toggle — remember it so freshly-opened overlays sync.
    channel.lastWind = loc.wind;
    payload = JSON.stringify({ wind: loc.wind, ts: Date.now() });
  } else if (typeof loc.units === "string") {
    // Units preference (imperial/metric) — remember for late-joining overlays.
    channel.lastUnits = loc.units;
    payload = JSON.stringify({ units: loc.units, ts: Date.now() });
  } else if ("power" in loc || "cadence" in loc || "hr" in loc) {
    // BLE sensor values (power/cadence/heart rate) — cache for late overlays.
    channel.lastSensors = { power: loc.power ?? null, cadence: loc.cadence ?? null, hr: loc.hr ?? null };
    payload = JSON.stringify({ ...channel.lastSensors, ts: Date.now() });
  } else if (loc.zones) {
    // Effort-zone anchors (FTP/LTHR/cadence/speed) — cache for late overlays.
    channel.lastZones = loc.zones;
    payload = JSON.stringify({ zones: loc.zones, ts: Date.now() });
  } else if (loc.hidden) {
    channel.lastLocation = { hidden: true, ts: Date.now() };
    payload = JSON.stringify(channel.lastLocation);
  } else {
    channel.lastLocation = { lat: loc.lat, lng: loc.lng, acc: loc.acc ?? null, hdg: loc.hdg ?? null,
        spd: loc.spd ?? null, dist: loc.dist ?? null, ts: Date.now() };
    // Append to the breadcrumb path (decimated) so late-joining overlays get the
    // whole route, not just the part since they connected.
    const pt = [loc.lat, loc.lng];
    if (!channel.lastPath.length || distM(channel.lastPath[channel.lastPath.length - 1], pt) >= TRAIL_MIN_M) {
      channel.lastPath.push(pt);
      if (channel.lastPath.length > TRAIL_MAX) channel.lastPath.shift();
    }
    payload = JSON.stringify(channel.lastLocation);
  }
  for (const o of channel.overlays) if (o.readyState === o.OPEN) o.send(payload, () => {});
}

// ---- Twitch chat badges (proxied via an app access token) ----
// The old no-auth badges.twitch.tv host was retired, so badge images now come
// from Helix, which needs an app token (CLIENT_ID + CLIENT_SECRET).
let appToken = null, appTokenExp = 0;
async function getAppToken() {
  if (appToken && Date.now() < appTokenExp - 60000) return appToken;
  const url = "https://id.twitch.tv/oauth2/token?client_id=" + encodeURIComponent(BADGE_CLIENT_ID) +
    "&client_secret=" + encodeURIComponent(CLIENT_SECRET) + "&grant_type=client_credentials";
  const r = await fetch(url, { method: "POST" });
  const j = await r.json();
  appToken = j.access_token;
  appTokenExp = Date.now() + ((j.expires_in || 3600) * 1000);
  return appToken;
}

const badgeCache = new Map(); // key -> { map, exp }
async function fetchBadges(roomId) {
  const key = roomId || "global";
  const hit = badgeCache.get(key);
  if (hit && Date.now() < hit.exp) return hit.map;
  const token = await getAppToken();
  const headers = { Authorization: "Bearer " + token, "Client-Id": BADGE_CLIENT_ID };
  const map = {}; // "set_id/version" -> image url
  const urls = ["https://api.twitch.tv/helix/chat/badges/global"];
  if (roomId) urls.push("https://api.twitch.tv/helix/chat/badges?broadcaster_id=" + encodeURIComponent(roomId));
  for (const u of urls) {
    const r = await fetch(u, { headers });
    const j = await r.json();
    for (const set of (j.data || [])) {
      for (const v of (set.versions || [])) {
        map[set.set_id + "/" + v.id] = v.image_url_2x || v.image_url_1x;
      }
    }
  }
  badgeCache.set(key, { map, exp: Date.now() + 60 * 60 * 1000 }); // cache 1h
  return map;
}

const server = http.createServer((req, res) => {
  const pathOnly = req.url.split("?")[0];

  // CORS preflight (the native app / browser may send one)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // OAuth bounce for the native app. Twitch only allows https redirect URIs, so it
  // sends the token here in the URL #fragment; this page forwards it into the app via
  // its custom scheme. The fragment never reaches the server, so JS handles the hand-off.
  if (req.method === "GET" && pathOnly === "/app-redirect") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Returning…</title></head>
<body style="background:#0a0b0d;color:#e8eaed;font-family:sans-serif;text-align:center;padding-top:80px">
<p>Returning to SlipstreamIRL…</p>
<a id="back" style="color:#9146ff">Tap here if it doesn't return automatically</a>
<script>
  var target = "slipstreamirl://redirect" + (window.location.hash || "");
  document.getElementById("back").href = target;
  window.location.replace(target);
</script>
</body></html>`);
    return;
  }

  // Health / token check — used by the app's "Test connection" button.
  //   GET /health?token=RELAY_TOKEN  -> 200 "ok" if token matches, else 403.
  //   Multi-tenant mode: GET /health?channel=<id>&token=<channel JWT>.
  if (req.method === "GET" && pathOnly === "/health") {
    const url = new URL(req.url, "http://x");
    if (MULTI_TENANT) {
      const channelId = channelIdFromRequest(url);
      const token = url.searchParams.get("token");
      const claims = channelId ? verifyChannelToken(token, JWT_SECRET) : null;
      const ok = !!claims && claims.channel === channelId;
      res.writeHead(ok ? 200 : 403, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain",
      });
      res.end(ok ? "ok" : "bad token");
      return;
    }
    const token = url.searchParams.get("token");
    res.writeHead(token === TOKEN ? 200 : 403, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain",
    });
    res.end(token === TOKEN ? "ok" : "bad token");
    return;
  }

  // Chat badge map for the chat overlay: GET /badges?room=<broadcaster_id>
  // Returns { "set_id/version": imageUrl, ... }. Empty {} if no CLIENT_SECRET.
  if (req.method === "GET" && pathOnly === "/badges") {
    const u = new URL(req.url, "http://x");
    const room = u.searchParams.get("room") || "";
    const done = (obj) => {
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!CLIENT_SECRET) { done({}); return; }
    fetchBadges(room).then(done).catch(() => done({}));
    return;
  }

  // HTTP location push — used by the native app while backgrounded (can't hold a WS open).
  //   POST /push?token=RELAY_TOKEN   body: {"lat":..,"lng":..,"acc":..}
  //   Multi-tenant mode: POST /push?channel=<id>&token=<channel JWT>
  if (req.method === "POST" && pathOnly === "/push") {
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("token");
    let channel;
    if (MULTI_TENANT) {
      const channelId = channelIdFromRequest(url);
      if (!channelId) { res.writeHead(400); res.end("channel required"); return; }
      const claims = verifyChannelToken(token, JWT_SECRET);
      if (!claims || claims.channel !== channelId) { res.writeHead(403); res.end("bad token"); return; }
      channel = getChannel(channelId);
    } else {
      if (token !== TOKEN) { res.writeHead(403); res.end("bad token"); return; }
      channel = defaultChannel;
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }
      // A {hidden:true} heartbeat (privacy geofence), {offline:true} signal
      // (stream stopped), or {wind:bool} toggle is allowed without coordinates;
      // otherwise lat/lng are required.
      const keyless = msg.hidden || msg.offline || typeof msg.wind === "boolean" || typeof msg.units === "string"
        || typeof msg.delay === "number" || typeof msg.liveStart === "number" || Array.isArray(msg.radar) || "power" in msg || "cadence" in msg || "hr" in msg || msg.zones;
      if (!keyless && (typeof msg.lat !== "number" || typeof msg.lng !== "number")) {
        res.writeHead(400); res.end("bad coords"); return;
      }
      broadcast(channel, msg);
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
      res.end("ok");
    });
    return;
  }

  // AI: generate a Twitch stream title from a dictated ride-plan transcript. The
  // app calls this before START STREAM, then applies the returned title to Twitch
  // itself using its own OAuth token — this endpoint only ever talks to Claude,
  // so the Anthropic key never has to leave the server.
  //   POST /ai/twitch-title?token=RELAY_TOKEN   body: {"transcript":"..."}
  if (req.method === "POST" && pathOnly === "/ai/twitch-title") {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    if (token !== TOKEN) { res.writeHead(401); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", async () => {
      const done = (status, obj) => {
        res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      let transcript;
      try { ({ transcript } = JSON.parse(body)); } catch { return done(400, { error: "bad json" }); }
      if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
        return done(400, { error: "transcript required" });
      }
      if (!ANTHROPIC_API_KEY) return done(503, { error: "ANTHROPIC_API_KEY not configured" });
      try {
        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-4-8",
            max_tokens: 300,
            messages: [{ role: "user", content: `${TWITCH_TITLE_PROMPT}\n\nRider's spoken plan:\n${transcript.trim()}` }],
            output_config: {
              format: {
                type: "json_schema",
                schema: {
                  type: "object",
                  properties: { title: { type: "string" } },
                  required: ["title"],
                  additionalProperties: false,
                },
              },
            },
          }),
        });
        const claudeData = await claudeRes.json();
        if (!claudeRes.ok || claudeData.stop_reason === "refusal") {
          return done(502, { error: "title generation failed" });
        }
        const text = (claudeData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        const parsed = JSON.parse(text);
        const title = String(parsed.title || "").trim().slice(0, 140);
        if (!title) return done(502, { error: "empty title" });
        done(200, { title });
      } catch (e) {
        done(502, { error: "title generation failed" });
      }
    });
    return;
  }

  // Ride summary: park a voice-dictated post-ride summary in this repo (via the
  // GitHub Contents API) so the later-running Strava/YouTube workflow can pick it
  // up — the relay itself has no persistent storage that would survive that long.
  //   POST /ride-summary?token=RELAY_TOKEN   body: {"summary":"...","recordedAt":"..."}
  if (req.method === "POST" && pathOnly === "/ride-summary") {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    if (token !== TOKEN) { res.writeHead(401); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e4) req.destroy(); });
    req.on("end", async () => {
      const done = (status, obj) => {
        res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      let summary, recordedAt;
      try { ({ summary, recordedAt } = JSON.parse(body)); } catch { return done(400, { error: "bad json" }); }
      if (!summary || typeof summary !== "string" || !summary.trim()) {
        return done(400, { error: "summary required" });
      }
      if (!GITHUB_CONTENT_PAT) return done(503, { error: "GITHUB_CONTENT_PAT not configured" });
      try {
        const ghHeaders = {
          Authorization: "Bearer " + GITHUB_CONTENT_PAT,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "slipstreamirl-relay",
        };
        const contentsUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${RIDE_SUMMARY_PATH}`;
        let sha;
        const getRes = await fetch(contentsUrl, { headers: ghHeaders });
        if (getRes.status === 200) sha = (await getRes.json()).sha;
        else if (getRes.status !== 404) throw new Error("github get failed " + getRes.status);

        // Trailing newline matters: the consuming workflow reads this file into a
        // GITHUB_OUTPUT heredoc block, and a file with no trailing newline glues its
        // closing delimiter onto the JSON's last line, breaking the step.
        const contentB64 = Buffer.from(JSON.stringify({
          summary: summary.trim(),
          recordedAt: recordedAt || new Date().toISOString(),
        }, null, 2) + "\n").toString("base64");
        const putRes = await fetch(contentsUrl, {
          method: "PUT",
          headers: ghHeaders,
          body: JSON.stringify({ message: "ride-summary: update from app", content: contentB64, sha }),
        });
        if (!putRes.ok) throw new Error("github put failed " + putRes.status);
        done(200, { ok: true });
      } catch (e) {
        done(502, { error: "failed to save ride summary" });
      }
    });
    return;
  }

  // Static preview of the Twitch extension (app's Overlay → Extension tab). Serves
  // the copied extension assets under /ext/… so the app can load them with ?relay.
  if (req.method === "GET" && pathOnly.startsWith("/ext/")) {
    const rel = pathOnly.replace(/^\/ext\//, "");
    if (rel.includes("..")) { res.writeHead(403); res.end(); return; }
    const type = rel.endsWith(".html") ? "text/html"
      : rel.endsWith(".js") ? "application/javascript"
      : rel.endsWith(".css") ? "text/css" : "application/octet-stream";
    fs.readFile(path.join(__dirname, "ext", rel), (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  }

  const file = PAGES[pathOnly];
  if (file) {
    fs.readFile(path.join(__dirname, file), "utf8", (err, html) => {
      if (err) { res.writeHead(500); res.end("missing " + file); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  if (MULTI_TENANT) {
    res.end("location relay up (multi-tenant, " + channels.size + " channel" + (channels.size === 1 ? "" : "s") + ")");
  } else {
    res.end("location relay up (broadcast delay " + defaultChannel.delayMs + "ms, timer-sync)");
  }
});

const wss = new WebSocketServer({ server });

// Per-channel state bundle: what used to be the module-level `overlays` Set
// plus the eight `last*` globals, now one object per channel. In multi-tenant
// mode there's one of these per streamer, keyed by channel id (their Twitch
// user id) in `channels`. In single-tenant mode there is exactly one, always
// `defaultChannel`, and `?channel=` from a caller is ignored — see
// channelIdFromRequest() below — so a BYO deployment can't accidentally end
// up multi-room just because a URL happened to carry that query param.
function freshChannelState() {
  return {
    overlays: new Set(),
    lastLocation: null, // cached so a freshly-opened overlay snaps to current position
    lastWind: null,     // cached wind on/off so a freshly-opened overlay syncs
    lastUnits: null,    // cached units pref so a freshly-opened overlay syncs
    lastSensors: null,  // cached power/cadence/hr so a freshly-opened overlay syncs
    lastZones: null,    // cached effort-zone anchors so a freshly-opened overlay syncs
    lastLiveStart: null,// cached go-live epoch ms so the elapsed timer survives overlay refreshes
    lastRadar: null,    // cached Varia radar targets so a freshly-opened overlay syncs
    lastPath: [],       // cached breadcrumb path [[lat,lng],…] so late overlays get the whole route
    delayMs: 4500,      // hold overlay broadcasts this long to sync with Twitch stream latency; set by the app
  };
}

const channels = new Map(); // channelId -> per-channel state bundle (multi-tenant mode only)
const DEFAULT_CHANNEL_ID = "__default__"; // single-tenant mode's one implicit room

function getChannel(id) {
  let ch = channels.get(id);
  if (!ch) { ch = freshChannelState(); channels.set(id, ch); }
  return ch;
}

// The one channel single-tenant mode ever uses — created eagerly so it exists
// from boot, same as the old module-level globals did.
const defaultChannel = !MULTI_TENANT ? getChannel(DEFAULT_CHANNEL_ID) : null;

// Resolves which channel a request/connection belongs to. In single-tenant
// mode this ALWAYS returns the fixed default id, ignoring any `?channel=` the
// caller sent — deliberately, so single-tenant behaviour can't be altered by
// an unexpected query param. In multi-tenant mode it requires a non-empty
// `?channel=<id>` and returns null if one wasn't given.
function channelIdFromRequest(url) {
  if (!MULTI_TENANT) return DEFAULT_CHANNEL_ID;
  const id = (url.searchParams.get("channel") || "").trim();
  return id || null;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const role = url.searchParams.get("role");   // "sender" | "overlay"
  const token = url.searchParams.get("token");

  if (role === "overlay") {
    let channel;
    if (MULTI_TENANT) {
      const channelId = channelIdFromRequest(url);
      if (!channelId) { ws.close(1008, "channel required"); return; }
      channel = channels.get(channelId);
      if (!channel) { ws.close(1008, "channel not active yet"); return; }
    } else {
      channel = defaultChannel;
    }
    channel.overlays.add(ws);
    ws.on("error", () => {});
    if (channel.lastWind !== null) ws.send(JSON.stringify({ wind: channel.lastWind }));
    if (channel.lastUnits !== null) ws.send(JSON.stringify({ units: channel.lastUnits }));
    if (channel.lastSensors) ws.send(JSON.stringify(channel.lastSensors));
    if (channel.lastZones) ws.send(JSON.stringify({ zones: channel.lastZones }));
    if (channel.lastLiveStart) ws.send(JSON.stringify({ liveStart: channel.lastLiveStart }));
    if (channel.lastRadar) ws.send(JSON.stringify({ radar: channel.lastRadar }));
    if (channel.lastPath.length) ws.send(JSON.stringify({ path: channel.lastPath }));
    if (channel.lastLocation) ws.send(JSON.stringify(channel.lastLocation));
    ws.on("close", () => channel.overlays.delete(ws));
    return;
  }

  if (role === "sender") {
    let channel;
    if (MULTI_TENANT) {
      const channelId = channelIdFromRequest(url);
      const claims = channelId ? verifyChannelToken(token, JWT_SECRET) : null;
      if (!claims || claims.channel !== channelId) { ws.close(1008, "bad token"); return; }
      channel = getChannel(channelId);
    } else {
      if (token !== TOKEN) { ws.close(1008, "bad token"); return; }
      channel = defaultChannel;
    }
    ws.on("error", () => {});
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      const keyless = msg.hidden || msg.offline || typeof msg.wind === "boolean" || typeof msg.units === "string"
        || typeof msg.delay === "number" || typeof msg.liveStart === "number" || Array.isArray(msg.radar) || "power" in msg || "cadence" in msg || "hr" in msg || msg.zones;
      if (!keyless && (typeof msg.lat !== "number" || typeof msg.lng !== "number")) return;
      broadcast(channel, msg);
    });
    return;
  }

  ws.close(1008, "unknown role");
});

server.listen(PORT, () => console.log("location relay listening on :" + PORT));
