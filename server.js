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
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || ""; // set in Render dashboard

// Serve the two pages straight from this service, so it's one deploy / one URL:
//   /          -> the control app (open this on your phone)
//   /overlay   -> the OBS browser source
const PAGES = {
  "/": "golive.html",
  "/overlay": "overlay.html",
};

const server = http.createServer((req, res) => {
  const file = PAGES[req.url.split("?")[0]];
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
    if (lastLocation) ws.send(JSON.stringify(lastLocation));
    ws.on("close", () => overlays.delete(ws));
    return;
  }

  if (role === "sender") {
    if (token !== TOKEN) { ws.close(1008, "bad token"); return; }
    ws.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (typeof msg.lat !== "number" || typeof msg.lng !== "number") return;
      lastLocation = { lat: msg.lat, lng: msg.lng, acc: msg.acc ?? null, ts: Date.now() };
      const payload = JSON.stringify(lastLocation);
      for (const o of overlays) if (o.readyState === o.OPEN) o.send(payload);
    });
    return;
  }

  ws.close(1008, "unknown role");
});

server.listen(PORT, () => console.log("location relay listening on :" + PORT));
