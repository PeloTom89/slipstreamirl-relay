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

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.RELAY_TOKEN || "change-me";
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || ""; // login app (public) — user OAuth
// Badge lookups use a Twitch app token (client credentials), which requires a
// CONFIDENTIAL app. The public login app can't have a secret, so this is a
// separate app: its Client ID + Secret below. Falls back to the login app's ID.
const BADGE_CLIENT_ID = process.env.TWITCH_BADGE_CLIENT_ID || CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";

// Serve the two pages straight from this service, so it's one deploy / one URL:
//   /          -> the control app (open this on your phone)
//   /overlay   -> the OBS browser source
const PAGES = {
  "/": "golive.html",
  "/overlay": "overlay.html",
  "/chat": "chat.html",
};

function broadcast(loc) {
  lastLocation = loc.hidden
    ? { hidden: true, ts: Date.now() }
    : { lat: loc.lat, lng: loc.lng, acc: loc.acc ?? null, hdg: loc.hdg ?? null, ts: Date.now() };
  const payload = JSON.stringify(lastLocation);
  for (const o of overlays) if (o.readyState === o.OPEN) o.send(payload, () => {});
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
  if (req.method === "GET" && pathOnly === "/health") {
    const token = new URL(req.url, "http://x").searchParams.get("token");
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
    const room = new URL(req.url, "http://x").searchParams.get("room") || "";
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
  if (req.method === "POST" && pathOnly === "/push") {
    const token = new URL(req.url, "http://x").searchParams.get("token");
    if (token !== TOKEN) { res.writeHead(403); res.end("bad token"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end("bad json"); return; }
      // A {hidden:true} heartbeat (sent while inside the privacy geofence) is
      // allowed without coordinates; otherwise lat/lng are required.
      if (!msg.hidden && (typeof msg.lat !== "number" || typeof msg.lng !== "number")) {
        res.writeHead(400); res.end("bad coords"); return;
      }
      broadcast(msg);
      res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
      res.end("ok");
    });
    return;
  }

  const file = PAGES[pathOnly];
  if (file) {
    fs.readFile(path.join(__dirname, file), "utf8", (err, html) => {
      if (err) { res.writeHead(500); res.end("missing " + file); return; }
      // inject Client ID + token into the control app so nothing is hardcoded
      if (file === "golive.html") {
        const cfg = `<script>window.__CONFIG__=${JSON.stringify({ CLIENT_ID, RELAY_TOKEN: TOKEN })};</script>`;
        html = html.replace("</head>", cfg + "\n</head>");
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("location relay up");
});

const wss = new WebSocketServer({ server });
const overlays = new Set();
let lastLocation = null; // cached so a freshly-opened overlay snaps to current position

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const role = url.searchParams.get("role");   // "sender" | "overlay"
  const token = url.searchParams.get("token");

  if (role === "overlay") {
    overlays.add(ws);
    ws.on("error", () => {});
    if (lastLocation) ws.send(JSON.stringify(lastLocation));
    ws.on("close", () => overlays.delete(ws));
    return;
  }

  if (role === "sender") {
    if (token !== TOKEN) { ws.close(1008, "bad token"); return; }
    ws.on("error", () => {});
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (typeof msg.lat !== "number" || typeof msg.lng !== "number") return;
      broadcast(msg);
    });
    return;
  }

  ws.close(1008, "unknown role");
});

server.listen(PORT, () => console.log("location relay listening on :" + PORT));
