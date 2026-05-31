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
const crypto = require("crypto");
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

const pendingAuth = new Map();

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function redirectHome(req, res, params = {}, hash = "") {
  const url = new URL("/", getBaseUrl(req));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.hash = hash;
  res.writeHead(302, { "Location": url.toString(), "Cache-Control": "no-store" });
  res.end();
}

function prunePendingAuth() {
  const now = Date.now();
  for (const [state, entry] of pendingAuth) {
    if (entry.expiresAt <= now) pendingAuth.delete(state);
  }
}

function getTokenErrorMessage(tokenRes, tokenJson) {
  if (tokenJson && (tokenJson.message || tokenJson.error_description || tokenJson.error)) {
    return tokenJson.message || tokenJson.error_description || tokenJson.error;
  }
  return "Twitch token exchange failed (" + tokenRes.status + ").";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const pathname = url.pathname;

  if (pathname === "/auth/twitch/start") {
    if (!CLIENT_ID) {
      redirectHome(req, res, { auth_error: "Missing Twitch Client ID." });
      return;
    }

    prunePendingAuth();

    const state = base64url(crypto.randomBytes(24));
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    const redirectUri = new URL("/auth/twitch/callback", getBaseUrl(req)).toString();
    const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "user:write:chat");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    pendingAuth.set(state, { verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.writeHead(302, { "Location": authUrl.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (pathname === "/auth/twitch/callback") {
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    if (error) {
      redirectHome(req, res, { auth_error: errorDescription || error });
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      redirectHome(req, res, { auth_error: "Missing Twitch authorization response." });
      return;
    }

    prunePendingAuth();
    const pending = pendingAuth.get(state);
    pendingAuth.delete(state);
    if (!pending) {
      redirectHome(req, res, { auth_error: "Expired Twitch sign-in session. Try again." });
      return;
    }

    try {
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      });
      const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      const tokenJson = await tokenRes.json().catch(() => null);
      if (!tokenRes.ok || !tokenJson || !tokenJson.access_token) {
        redirectHome(req, res, { auth_error: getTokenErrorMessage(tokenRes, tokenJson) });
        return;
      }

      redirectHome(req, res, {}, new URLSearchParams({ access_token: tokenJson.access_token }).toString());
    } catch (err) {
      console.error("Twitch sign-in failed", err);
      redirectHome(req, res, { auth_error: "Twitch sign-in failed. Try again." });
    }
    return;
  }

  const file = PAGES[pathname];
  if (file) {
    fs.readFile(path.join(__dirname, file), "utf8", (err, html) => {
      if (err) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("missing " + file); return; }
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
