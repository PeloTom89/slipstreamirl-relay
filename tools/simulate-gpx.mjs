// simulate-gpx.mjs — replay a GPX route (or a synthetic loop) into the relay so you can
// watch the overlays (rider, breadcrumb trail, course-up rotation, speed/distance) without
// going outside. It pushes to /push exactly like the phone app does.
//
// Usage:
//   node tools/simulate-gpx.mjs [route.gpx] --token YOUR_RELAY_TOKEN [options]
//   node tools/simulate-gpx.mjs --token YOUR_RELAY_TOKEN --loop      (no file = circular test loop)
//
// Options (env vars RELAY_TOKEN / RELAY_URL also work):
//   --token T     relay token (required; the RELAY_TOKEN you set on Render / in the app)
//   --relay URL   relay base (default https://irl-stream-control.onrender.com)
//   --speed 25    simulated speed in km/h (default 25)
//   --mult 1      playback multiplier (e.g. 5 = fast-forward through the route)
//   --loop        repeat forever (Ctrl+C to stop)
//
// Tip: set the app's Stream Sync Delay to 0 while testing, or the ride shows up delayed.

import fs from "fs";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf("--" + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return (v && !v.startsWith("--")) ? v : true;
};

const gpxPath = args.find((a) => !a.startsWith("--") && /\.gpx$/i.test(a));
const RELAY = String(flag("relay", process.env.RELAY_URL || "https://irl-stream-control.onrender.com")).replace(/\/+$/, "");
const TOKEN = flag("token", process.env.RELAY_TOKEN || "");
const SPEED_KMH = parseFloat(flag("speed", 25)) || 25;
const MULT = parseFloat(flag("mult", 1)) || 1;
const LOOP = !!flag("loop", false);
const TICK_MS = 1000;

if (!TOKEN) {
  console.error("Missing relay token. Pass --token <RELAY_TOKEN> or set the RELAY_TOKEN env var.");
  process.exit(1);
}

function parseGpx(xml) {
  const tags = xml.match(/<(?:trkpt|rtept)\b[^>]*>/gi) || [];
  const pts = [];
  for (const t of tags) {
    const la = t.match(/lat="([-\d.]+)"/i), lo = t.match(/lon="([-\d.]+)"/i);
    if (la && lo) pts.push([parseFloat(la[1]), parseFloat(lo[1])]);
  }
  return pts;
}
function circleRoute(lat, lng, rM, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([lat + (rM * Math.cos(a)) / 111320, lng + (rM * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180))]);
  }
  return pts;
}

let route;
if (gpxPath) {
  route = parseGpx(fs.readFileSync(gpxPath, "utf8"));
  if (route.length < 2) { console.error("No <trkpt>/<rtept> points found in " + gpxPath); process.exit(1); }
  console.log(`Loaded ${route.length} points from ${gpxPath}`);
} else {
  route = circleRoute(41.8826, -87.6233, 800, 160);
  console.log("No GPX given — simulating an 800 m circular loop near Chicago.");
}

const distM = (a, b) => {
  const R = 6371000, dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  const lat = (a[0] + b[0]) / 2 * Math.PI / 180, x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
};
const bearing = (a, b) => {
  const lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const cum = [0];
for (let i = 1; i < route.length; i++) cum[i] = cum[i - 1] + distM(route[i - 1], route[i]);
const total = cum[cum.length - 1];

function at(d) {
  if (d <= 0) return { pt: route[0], hdg: bearing(route[0], route[1]) };
  if (d >= total) return { pt: route[route.length - 1], hdg: bearing(route[route.length - 2], route[route.length - 1]) };
  let i = 1; while (cum[i] < d) i++;
  const segLen = cum[i] - cum[i - 1] || 1, f = (d - cum[i - 1]) / segLen;
  const a = route[i - 1], b = route[i];
  return { pt: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], hdg: bearing(a, b) };
}

async function push(body) {
  try {
    await fetch(`${RELAY}/push?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) { console.error("push failed:", e.message); }
}

const mps = SPEED_KMH / 3.6;
let dist = 0;
console.log(`Simulating ${(total / 1000).toFixed(2)} km at ${SPEED_KMH} km/h x${MULT}${LOOP ? " (looping)" : ""} -> ${RELAY}`);
console.log("Open an overlay (e.g. /overlay or /karoo) to watch. Ctrl+C to stop.");
await push({ liveStart: Date.now() });

const timer = setInterval(async () => {
  const { pt, hdg } = at(dist);
  await push({ lat: pt[0], lng: pt[1], hdg: Math.round(hdg), spd: mps, dist: Math.round(dist) });
  dist += mps * MULT * (TICK_MS / 1000);
  if (dist > total) {
    if (LOOP) { dist = 0; }
    else { clearInterval(timer); await push({ offline: true }); console.log("Route finished."); process.exit(0); }
  }
}, TICK_MS);

process.on("SIGINT", async () => { clearInterval(timer); await push({ offline: true }); console.log("\nStopped."); process.exit(0); });
