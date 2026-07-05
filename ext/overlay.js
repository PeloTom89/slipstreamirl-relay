/* SlipstreamIRL Twitch Extension — video overlay.
   Self-contained map (Leaflet) + bike-computer stats + effort-zone colors,
   fed by the broadcaster's relay over WebSocket. Relay URL comes from the
   extension's broadcaster configuration (set on the config page). */

const ZOOM = 16;
// Default relay; map tiles are proxied through it (Twitch CSP blocks OSM directly).
const DEFAULT_RELAY = "https://irl-stream-control.onrender.com";
let relayBase = null;
let ws = null;

// Units: the broadcaster sets a default via the relay, but each viewer can override
// it for their own view (persisted in their browser). Declared up top so the
// control wiring below can use it without a temporal-dead-zone error.
let broadcasterUnits = "imperial";
let viewerUnits = null;
try { const u = localStorage.getItem("slipUnits"); if (u === "imperial" || u === "metric") viewerUnits = u; } catch {}
let units = viewerUnits || broadcasterUnits;
function recomputeUnits() {
  units = viewerUnits || broadcasterUnits;
  applyUnits();
  updateToggleLabels();
}

// Wind arrows + effort zones: broadcaster sets the default; each viewer can override
// for their own view (null = follow broadcaster).
let broadcasterWind = true, viewerWind = null;
try { const w = localStorage.getItem("slipWind"); if (w === "on") viewerWind = true; else if (w === "off") viewerWind = false; } catch {}
function windOn() { return viewerWind !== null ? viewerWind : broadcasterWind; }
// Wind arrows move at the wind's real ground speed for the map's zoom/latitude,
// amplified by this factor so it's visible (1 = literal, ~frozen at zoom 16).
const WIND_EXAGGERATION = 8;
// Course-up map rotation (per viewer). Default on (map spins so travel points up,
// like a car GPS); the gear menu's "North Up" toggle locks north-up. Persisted.
let northUp = false;
try { northUp = localStorage.getItem("slipNorthUp") === "1"; } catch {}
// MapLibre rotates natively (vector labels stay upright). Course-up = map bearing
// equals the rider's heading; North Up = bearing 0. The bearing is applied as part
// of each placement (place); the toggle re-orients immediately via applyBearing().
function desiredBearing() { return northUp ? 0 : (lastHdg >= 0 ? lastHdg : 0); }
function applyBearing() {
  if (typeof map === "undefined" || !map) return;
  map.easeTo({ bearing: desiredBearing(), duration: 500, easing: (t) => t });
}
// Breadcrumb trail on/off (per viewer, persisted). Default on.
let trailOn = true;
try { trailOn = localStorage.getItem("slipTrail") !== "off"; } catch {}
let zones = null;  // latest {zones:{enabled,...}} from the relay (declared up top to avoid TDZ)
let viewerZones = null;
try { const z = localStorage.getItem("slipZones"); if (z === "on") viewerZones = true; else if (z === "off") viewerZones = false; } catch {}
function zonesActive() { return !!zones && (viewerZones !== null ? viewerZones : zones.enabled !== false); }
function updateToggleLabels() {
  const uv = document.getElementById("unitsVal"); if (uv) uv.textContent = units === "metric" ? "Metric" : "Imperial";
  const ut = document.getElementById("unitsTgl"); if (ut) ut.classList.toggle("on", units === "metric");
  const zt = document.getElementById("zonesTgl"); if (zt) zt.classList.toggle("on", zonesActive());
  const wt = document.getElementById("windTgl"); if (wt) wt.classList.toggle("on", windOn());
  const nt = document.getElementById("northTgl"); if (nt) nt.classList.toggle("on", northUp);
  const tt = document.getElementById("trailTgl"); if (tt) tt.classList.toggle("on", trailOn);
}

const deviceEl = document.getElementById("device");
const hintEl = document.getElementById("hint");

/* ---------- per-viewer hide toggle ----------
   Each viewer runs their own copy, so this only hides it for them. Persisted in
   localStorage (the extension's iframe origin) so it sticks across reloads. */
const hideBtn = document.getElementById("hideBtn");
const showPill = document.getElementById("showPill");
let viewerHidden = false;
try { viewerHidden = localStorage.getItem("slipHidden") === "1"; } catch {}
function applyHidden() {
  if (!hideBtn) return;   // controls absent (e.g. mobile view) — nothing to do
  deviceEl.classList.toggle("vhide", viewerHidden);
  // The "show" pill only makes sense once we have a relay/connection to show.
  if (showPill) showPill.style.display = (viewerHidden && relayBase) ? "block" : "none";
}
if (hideBtn) hideBtn.addEventListener("click", () => {
  viewerHidden = true;
  try { localStorage.setItem("slipHidden", "1"); } catch {}
  applyHidden();
});
if (showPill) showPill.addEventListener("click", () => {
  viewerHidden = false;
  try { localStorage.setItem("slipHidden", "0"); } catch {}
  applyHidden();
});

/* ---------- per-viewer position + size (tap-based: corner snap + size steppers) ----------
   Each viewer picks a corner and a size for their own view; stored in localStorage.
   No click-and-hold — tap a corner to place it, tap -/+ to resize.
   Schema: { corner:"tl|tr|bl|br", height:px }. */
let layoutCorner = "tl";
let layoutHeight = null; // px; null = use the CSS default height
function loadLayout() { try { return JSON.parse(localStorage.getItem("slipLayout")); } catch { return null; } }
function saveLayout() {
  try { localStorage.setItem("slipLayout", JSON.stringify({ corner: layoutCorner, height: layoutHeight })); } catch {}
}
function cornerStyle(corner) {
  const M = "2vmin";
  deviceEl.style.top = deviceEl.style.bottom = deviceEl.style.left = deviceEl.style.right = "auto";
  if (corner === "tr") { deviceEl.style.right = M; deviceEl.style.top = M; }
  else if (corner === "bl") { deviceEl.style.left = M; deviceEl.style.bottom = M; }
  else if (corner === "br") { deviceEl.style.right = M; deviceEl.style.bottom = M; }
  else { deviceEl.style.left = M; deviceEl.style.top = M; } // tl (default)
}
function applySize() {
  if (!layoutHeight) return;
  deviceEl.style.height = layoutHeight + "px";
  deviceEl.style.width = (layoutHeight * 0.62) + "px";     // width follows height (fixed ratio)
  deviceEl.style.fontSize = (layoutHeight * 0.0233) + "px"; // scale text with the device
}
function markCornerSel() {
  document.querySelectorAll(".cornerBtn").forEach((b) => b.classList.toggle("sel", b.dataset.corner === layoutCorner));
}
function applyLayout() {
  if (!document.getElementById("sizeUp")) return; // no layout controls (e.g. mobile view)
  const l = loadLayout();
  if (l) { layoutCorner = l.corner || "tl"; layoutHeight = l.height || null; }
  cornerStyle(layoutCorner);
  applySize();
  markCornerSel();
  if (typeof map !== "undefined" && map && map.resize) map.resize();
}
function setCorner(c) { layoutCorner = c; cornerStyle(c); markCornerSel(); saveLayout(); if (typeof map !== "undefined" && map && map.resize) map.resize(); }
function stepSize(delta) {
  const cur = deviceEl.getBoundingClientRect().height;
  const minH = window.innerHeight * 0.25, maxH = window.innerHeight * 0.95;
  layoutHeight = Math.max(minH, Math.min(maxH, cur + delta));
  applySize();
  saveLayout();
  if (typeof map !== "undefined" && map && map.resize) map.resize();
}

const infoEl = document.getElementById("gearBtn"); // gear opens the settings menu
const scrimEl = document.getElementById("ctrlScrim");
const backEl = document.getElementById("backBtn");
function closeCtrls() { deviceEl.classList.remove("ctrlsOpen"); }
if (infoEl) infoEl.addEventListener("click", () => deviceEl.classList.toggle("ctrlsOpen"));
if (scrimEl) scrimEl.addEventListener("click", closeCtrls);
if (backEl) backEl.addEventListener("click", closeCtrls);
document.querySelectorAll(".cornerBtn").forEach((b) => b.addEventListener("click", () => setCorner(b.dataset.corner)));
const sizeUpEl = document.getElementById("sizeUp"), sizeDownEl = document.getElementById("sizeDown");
if (sizeUpEl) sizeUpEl.addEventListener("click", () => stepSize(window.innerHeight * 0.06));
if (sizeDownEl) sizeDownEl.addEventListener("click", () => stepSize(-window.innerHeight * 0.06));

const unitsEl = document.getElementById("unitsTgl");
if (unitsEl) unitsEl.addEventListener("click", () => {
  viewerUnits = (units === "metric") ? "imperial" : "metric";
  try { localStorage.setItem("slipUnits", viewerUnits); } catch {}
  recomputeUnits();
});
const zonesBtn = document.getElementById("zonesTgl");
if (zonesBtn) zonesBtn.addEventListener("click", () => {
  viewerZones = !zonesActive();
  try { localStorage.setItem("slipZones", viewerZones ? "on" : "off"); } catch {}
  recolorAll(); updateToggleLabels();
});
const windBtn = document.getElementById("windTgl");
if (windBtn) windBtn.addEventListener("click", () => {
  viewerWind = !windOn();
  try { localStorage.setItem("slipWind", viewerWind ? "on" : "off"); } catch {}
  updateToggleLabels();
});
const northBtn = document.getElementById("northTgl");
if (northBtn) northBtn.addEventListener("click", () => {
  northUp = !northUp;
  try { localStorage.setItem("slipNorthUp", northUp ? "1" : "0"); } catch {}
  applyBearing();
  updateToggleLabels();
});
const trailBtn = document.getElementById("trailTgl");
if (trailBtn) trailBtn.addEventListener("click", () => {
  trailOn = !trailOn;
  try { localStorage.setItem("slipTrail", trailOn ? "on" : "off"); } catch {}
  applyTrailVis();
  updateToggleLabels();
});
updateToggleLabels();

// Map controls (always-visible on the map): zoom in/out + recenter (resume follow).
const zinBtn = document.getElementById("zinBtn");
const zoutBtn = document.getElementById("zoutBtn");
const recenterBtn = document.getElementById("recenterBtn");
if (zinBtn) zinBtn.addEventListener("click", () => {
  if (following) { followZoom = Math.min(19, followZoom + 1); map.easeTo({ zoom: followZoom, duration: 300 }); }
  else map.zoomTo(map.getZoom() + 1, { duration: 300 });
});
if (zoutBtn) zoutBtn.addEventListener("click", () => {
  if (following) { followZoom = Math.max(1, followZoom - 1); map.easeTo({ zoom: followZoom, duration: 300 }); }
  else map.zoomTo(map.getZoom() - 1, { duration: 300 });
});
if (recenterBtn) recenterBtn.addEventListener("click", () => {
  following = true; followZoom = ZOOM;
  if (markerLL) map.easeTo({ center: [markerLL[1], markerLL[0]], zoom: followZoom, bearing: desiredBearing(), duration: 600 });
});

/* ---------- map (MapLibre GL vector) ----------
   Vector tiles render street/landmark labels as live text, so they stay UPRIGHT
   when the map rotates course-up (the whole reason for the engine swap). MapLibre
   spins its workers from same-origin files (the CSP build), so it runs inside the
   Twitch extension iframe whose script-src is 'self' (no blob: needed). Vector
   tiles + glyphs + sprite are fetched from tiles.openfreemap.org, which the
   broadcaster must add to the extension's URL-fetch allowlist (connect-src). */
maplibregl.setWorkerUrl("vendor/maplibre-gl-csp-worker.js");
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [0, 0], zoom: ZOOM, bearing: 0,
  attributionControl: false, interactive: true, fadeDuration: 0,
  dragRotate: false, pitchWithRotate: false, touchPitch: false,
  touchZoomRotate: false, scrollZoom: false, keyboard: false, doubleClickZoom: false,
});
let mapLoaded = false;
map.on("load", () => {
  mapLoaded = true;
  map.addSource("trail", { type: "geojson", data: trailGeo() });
  map.addLayer({
    id: "trail", type: "line", source: "trail",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#1a6abf", "line-width": 4, "line-opacity": 0.65 },
  });
  if (!trailOn) map.setLayoutProperty("trail", "visibility", "none");
  if (trailPts.length) trailSync();  // flush any points received before load
});

// Viewer map controls: follow mode keeps the map centred on the rider; dragging
// the map turns it off; Recenter turns it back on. Zoom is driven by followZoom
// while following, or the map's own zoom when freely panned.
let following = true, followZoom = ZOOM;
map.on("dragstart", () => { following = false; });

let stale = false, lastHdg = 0, gotFix = false, staleTimer = null;
let marker = null, markerLL = null, onMap = false; // markerLL = [lat,lng]
let lastFixMs = 0;
const STALE_MS = 30000;

// Breadcrumb trail: a GeoJSON line layer of the route. Points come from the live
// position stream; the relay also replays the whole route on connect. Decimated +
// capped to stay light. trailPts are stored as [lng,lat] (MapLibre order).
const TRAIL_MIN_M = 25, TRAIL_MAX = 8000; // ~200 km / ~125 mi of trail
let trailPts = []; // [lng,lat]
function trailGeo() { return { type: "Feature", geometry: { type: "LineString", coordinates: trailPts } }; }
function trailDistM(a, b) { // a,b = [lat,lng]
  const R = 6371000, dLat = (b[0]-a[0])*Math.PI/180, dLng = (b[1]-a[1])*Math.PI/180,
    lat = (a[0]+b[0])/2*Math.PI/180, x = dLng*Math.cos(lat);
  return Math.sqrt(dLat*dLat + x*x) * R;
}
function trailSync() { const s = mapLoaded && map.getSource("trail"); if (s) s.setData(trailGeo()); }
function addTrailPoint(lat, lng) {
  if (trailPts.length) { const last = trailPts[trailPts.length-1]; if (trailDistM([last[1], last[0]], [lat, lng]) < TRAIL_MIN_M) return; }
  trailPts.push([lng, lat]);
  if (trailPts.length > TRAIL_MAX) trailPts.shift();
  trailSync();
}
function setTrail(pts) {            // relay replay of the whole route on connect ([lat,lng] pairs)
  trailPts = Array.isArray(pts) ? pts.slice(-TRAIL_MAX).map((p) => [p[1], p[0]]) : [];
  trailSync();
}
function applyTrailVis() {
  if (!mapLoaded || !map.getLayer("trail")) return;
  map.setLayoutProperty("trail", "visibility", trailOn ? "visible" : "none");
}

function armStale() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => setStale(true), STALE_MS);
}
// The cyclist is drawn pointing UP; the MapLibre marker's setRotation turns it in
// map space (rotationAlignment:"map"), so it points along travel in north-up and
// straight up in course-up — no inner CSS rotation needed.
function cyclistSVG() {
  return `<svg width="26" height="40" viewBox="-22 -33 44 66" style="filter:drop-shadow(0 3px 7px rgba(0,0,0,.75))">
    <ellipse cx="0" cy="-27" rx="4.5" ry="11" fill="#111"/><ellipse cx="0" cy="27" rx="4.5" ry="11" fill="#111"/>
    <rect x="-1.5" y="-15" width="3" height="42" rx="1.5" fill="#555"/>
    <ellipse cx="0" cy="8" rx="9" ry="13" fill="#1a6abf"/><ellipse cx="0" cy="-4" rx="11" ry="5.5" fill="#1a6abf"/>
    <line x1="-11" y1="-4" x2="-13" y2="-20" stroke="#1a6abf" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="11" y1="-4" x2="13" y2="-20" stroke="#1a6abf" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="-15" y1="-20" x2="15" y2="-20" stroke="#2a2a2a" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="0" cy="-14" rx="8.5" ry="9.5" fill="#ffffff"/></svg>`;
}
const meEl = document.createElement("div");
meEl.className = "me-wrap";
function buildMe() {
  const inner = stale ? '<div class="qmark">' + cyclistSVG() + '</div>' : cyclistSVG();
  meEl.innerHTML = '<div class="me-halo"><div class="pulse-ring"></div></div><div class="me-icon">' + inner + '</div>';
}
buildMe();
marker = new maplibregl.Marker({ element: meEl, rotationAlignment: "map", anchor: "center" });
function applyRotation() { marker.setRotation(stale ? 0 : (lastHdg >= 0 ? lastHdg : 0)); }
function render() { meEl.classList.toggle("stale", stale); buildMe(); applyRotation(); }
function updateHeading() { if (!stale) applyRotation(); }
function setStale(s) { if (s === stale) return; stale = s; render(); }
function goOffline() {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null; stale = false; gotFix = false;
  if (onMap) { marker.remove(); onMap = false; }
  markerLL = null;
  startTs = null; if (elElapsed) elElapsed.textContent = "0:00:00"; // stream ended — reset ride timer
  renderRadar([]); // clear the radar strip
  trailPts = []; trailSync(); // clear the breadcrumb trail
}

// Varia radar strip: a dot per vehicle by distance (you/near at the top, far behind
// at the bottom), colored by threat. Empty list hides the strip.
const RADAR_MAXD = 150;
const RADAR_CLEAR_GRACE = 1000; // ms — ignore brief empty frames (a car passing) before hiding
let radarLastSeen = 0;
function renderRadar(targets) {
  const wrap = document.getElementById("radar");
  if (!wrap) return;
  if (!targets || !targets.length) {
    // A passing car can momentarily blank the whole list; keep the other vehicles on
    // screen until the road's been clear a beat, so they don't flicker out.
    if (Date.now() - radarLastSeen < RADAR_CLEAR_GRACE) return;
    wrap.querySelectorAll(".radarDot").forEach((el) => el.remove());
    wrap.style.display = "none";
    return;
  }
  radarLastSeen = Date.now();
  wrap.querySelectorAll(".radarDot").forEach((el) => el.remove());
  wrap.style.display = "block";
  for (const t of targets) {
    const el = document.createElement("div");
    el.className = "radarDot " + (t.threat >= 2 ? "t2" : t.threat >= 1 ? "t1" : "t0");
    const frac = Math.max(0, Math.min(1, (t.dist || 0) / RADAR_MAXD));
    el.style.top = (frac * 100) + "%"; // near=top, far behind=bottom
    wrap.appendChild(el);
  }
}
function place(lat, lng, hdg) {
  lastHdg = hdg;
  addTrailPoint(lat, lng);
  markerLL = [lat, lng];
  const ll = [lng, lat];          // MapLibre uses [lng,lat]
  marker.setLngLat(ll);
  applyRotation();
  if (!onMap) { marker.addTo(map); onMap = true; }
  // Course-up: bearing follows heading (North Up locks 0). The marker is a real
  // geo marker, so MapLibre keeps it in place whether we follow or the viewer pans.
  const bearing = desiredBearing();
  if (!gotFix) {
    gotFix = true;
    map.jumpTo({ center: ll, bearing, zoom: followZoom });
  } else if (following) {
    map.easeTo({ center: ll, bearing, zoom: followZoom, duration: 1000, easing: (t) => t });
  }
  lastFixMs = performance.now(); stale = false; armStale();
}

/* ---------- wind ---------- */
const canvas = document.getElementById("wind-canvas");
const ctx = canvas.getContext("2d");
let wind = null, motionScale = 1, drawScale = 1, arrowOffsets = null, lastWindFetch = 0;
function resizeCanvas() {
  const w = canvas.offsetWidth, h = canvas.offsetHeight;
  if (w && h && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w; canvas.height = h;
    arrowOffsets = null; // re-space arrows for the new size next frame
  }
  if (canvas.height) { const r = canvas.height / 700; motionScale = r; drawScale = Math.sqrt(r); }
}
window.addEventListener("resize", resizeCanvas); resizeCanvas();
// Re-sync the canvas resolution whenever its box changes (window resize, viewer
// drag-resize, layout) so the wind arrows stay aligned with the map.
if (window.ResizeObserver) { new ResizeObserver(() => resizeCanvas()).observe(canvas); }
function animateWind() {
  requestAnimationFrame(animateWind);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!windOn() || !wind || windDir == null || !gotFix) return;
  const travel = Math.sqrt(canvas.width ** 2 + canvas.height ** 2) * 0.65;
  const numArrows = 3;
  if (arrowOffsets === null) arrowOffsets = Array.from({ length: numArrows }, (_, i) => -travel + i * (2 * travel / numArrows));
  // Rider's screen position (centred while following; wherever it is when panned).
  let cx = canvas.width / 2, cy = canvas.height / 2;
  if (markerLL && map.project) { const p = map.project([markerLL[1], markerLL[0]]); cx = p.x; cy = p.y; }
  // The wind canvas is screen-fixed (it does NOT rotate with the map), so subtract
  // the map bearing to keep the arrows pointing in the wind's true compass direction.
  const phi = (((windDir + 180) - map.getBearing()) * Math.PI) / 180; // blowing-TO, minus bearing
  const vx = Math.sin(phi), vy = -Math.cos(phi), angle = Math.atan2(vy, vx);
  const s = 22 * drawScale, fadeZone = travel * 0.25;
  // Real px/frame from the map's metres-per-pixel at this zoom + rider latitude.
  const lat = markerLL ? markerLL[0] : 0;
  const mPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  const pxPerFrame = ((wind.speed / 3.6) / mPerPx) / 60 * WIND_EXAGGERATION; // km/h -> m/s -> px
  for (let i = 0; i < numArrows; i++) {
    arrowOffsets[i] += pxPerFrame;  // wind's true ground speed for the map scale
    if (arrowOffsets[i] > travel) arrowOffsets[i] = -travel;
    const t = (arrowOffsets[i] + fadeZone) / (2 * fadeZone);
    const alpha = (t >= 0 && t <= 1) ? Math.sin(Math.PI * t) * 0.95 : 0;
    if (alpha <= 0) continue;
    const x = cx + vx * arrowOffsets[i], y = cy + vy * arrowOffsets[i];
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.globalAlpha = alpha;
    ctx.fillStyle = "#5b9cf6"; ctx.shadowColor = "rgba(30,80,200,0.5)"; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.5, -s * 0.55); ctx.lineTo(-s * 0.2, 0); ctx.lineTo(-s * 0.5, s * 0.55); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
animateWind();
async function fetchWind(lat, lng) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=wind_speed_10m,wind_direction_10m,temperature_2m`);
    const data = await r.json();
    const spd = data.current.wind_speed_10m, dir = data.current.wind_direction_10m;
    const rad = ((dir + 180) % 360) * Math.PI / 180;
    // Arrow flow speed is linearly proportional to real wind speed (km/h); calm
    // wind => no arrows, rather than an artificial minimum drift.
    wind = (spd < 1) ? null : { vx: Math.sin(rad), vy: -Math.cos(rad), speed: spd };
    windKmh = spd; windDir = dir; tempC = data.current.temperature_2m;
    renderWind(); renderTemp();
  } catch {}
}

/* ---------- stats + zones ---------- */
const elSpeed = document.getElementById("speed"), elDist = document.getElementById("dist");
const elPower = document.getElementById("power"), elCadence = document.getElementById("cadence"), elHr = document.getElementById("hr");
const elWind = document.getElementById("wind"), elWindArrow = document.getElementById("windArrow");
const elWindDir = document.getElementById("windDir");
const elTemp = document.getElementById("temp");
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const toCardinal = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const elElapsed = document.getElementById("elapsed"), elClock = document.getElementById("clock");
let startTs = null, lastSpdMs = 0, lastDistM = 0, lastPower = null, lastCadence = null, lastHr = null;
let windKmh = null, windDir = null, tempC = null;
const ZONE_COLORS = ["#1f9d57", "#caa000", "#e07b1a", "#d8392b", "#8a3fd4"];

const toSpeed = ms => ms * (units === "metric" ? 3.6 : 2.23694);
const toDist = m => m / (units === "metric" ? 1000 : 1609.34);
function renderWind() {
  if (windKmh == null || !elWind) return;
  elWind.textContent = (units === "metric" ? windKmh : windKmh * 0.621371).toFixed(0);
  document.getElementById("windUnit").textContent = units === "metric" ? "km/h" : "mph";
  if (windDir != null && elWindDir) elWindDir.textContent = toCardinal(windDir);
}
function renderTemp() {
  if (tempC == null || !elTemp) return;
  elTemp.textContent = Math.round(units === "metric" ? tempC : tempC * 9 / 5 + 32) + (units === "metric" ? "°C" : "°F");
}
function applyUnits() {
  document.getElementById("speedUnit").textContent = units === "metric" ? "km/h" : "mph";
  document.getElementById("distUnit").textContent = units === "metric" ? "km" : "mi";
  elSpeed.textContent = toSpeed(lastSpdMs).toFixed(0);
  elDist.textContent = toDist(lastDistM).toFixed(1);
  renderWind();
  renderTemp();
}
function zoneIndex(metric, value) {
  if (!zonesActive() || value == null) return -1;
  if (metric === "power" && zones.ftp) { const f = zones.ftp; return value < f*0.55?0:value<f*0.76?1:value<f*0.91?2:value<f*1.06?3:4; }
  if (metric === "hr" && zones.lthr) { const l = zones.lthr, mx = zones.maxhr || l*1.1, mid = l + (mx-l)*0.5; return value<l*0.85?0:value<l*0.92?1:value<l?2:value<mid?3:4; }
  if (metric === "cadence" && zones.cadence) { const a = zones.cadence; return value<a*0.82?0:value<a?1:value<a*1.18?2:value<a*1.29?3:4; }
  if (metric === "speed" && zones.speed) { const s = zones.speed; return value<s*0.44?0:value<s*0.64?1:value<s*0.84?2:value<s*1.2?3:4; }
  return -1;
}
function colorCard(id, metric, value) {
  const el = document.getElementById(id), z = zoneIndex(metric, value);
  el.style.color = z < 0 ? "" : ZONE_COLORS[z];
}
function recolorAll() {
  colorCard("speed", "speed", lastSpdMs); colorCard("power", "power", lastPower);
  colorCard("cadence", "cadence", lastCadence); colorCard("hr", "hr", lastHr);
}
function setSpeed(ms) { lastSpdMs = ms || 0; elSpeed.textContent = toSpeed(lastSpdMs).toFixed(0); colorCard("speed", "speed", lastSpdMs); }
function setDist(m) { lastDistM = m || 0; elDist.textContent = toDist(lastDistM).toFixed(1); }
function setSensors(d) {
  if (d.power != null) { lastPower = d.power; elPower.textContent = Math.round(d.power); colorCard("power", "power", lastPower); }
  if (d.cadence != null) { lastCadence = d.cadence; elCadence.textContent = Math.round(d.cadence); colorCard("cadence", "cadence", lastCadence); }
  if (d.hr != null) { lastHr = d.hr; elHr.textContent = Math.round(d.hr); colorCard("hr", "hr", lastHr); }
}
function two(n) { return (n < 10 ? "0" : "") + n; }
setInterval(() => {
  const d = new Date();
  elClock.textContent = d.getHours() + ":" + two(d.getMinutes());
  if (startTs) {
    let s = Math.floor((Date.now() - startTs) / 1000);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    elElapsed.textContent = h + ":" + two(m) + ":" + two(s);
  }
}, 1000);

/* ---------- relay connection ---------- */
function connect() {
  if (!relayBase) return;
  hintEl.style.display = "none";
  deviceEl.classList.add("on");
  applyHidden();
  applyLayout();
  // The map was created while the device was hidden, so it had no size and rendered
  // only part of itself. Recompute now that it's visible.
  if (map && map.resize) { try { map.resize(); } catch {} setTimeout(() => { try { map.resize(); } catch {} }, 80); }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  const url = relayBase.replace(/^http/, "ws") + "?role=overlay";
  ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (typeof d.units === "string") { broadcasterUnits = d.units; recomputeUnits(); }
      if (typeof d.wind === "boolean") { broadcasterWind = d.wind; updateToggleLabels(); }
      if (d.zones) { zones = d.zones; recolorAll(); updateToggleLabels(); return; }
      if (typeof d.liveStart === "number") {
        // Anchor the elapsed timer to when the rider went live (survives refreshes).
        startTs = d.liveStart || null;
        if (!startTs) elElapsed.textContent = "0:00:00";
        return;
      }
      if (Array.isArray(d.radar)) { renderRadar(d.radar); return; }
      if (Array.isArray(d.path)) { setTrail(d.path); return; }   // whole route replayed on connect
      if ("power" in d || "cadence" in d || "hr" in d) { setSensors(d); return; }
      if (d.offline) { goOffline(); setSpeed(0); return; }
      if (d.hidden) { setStale(true); armStale(); setSpeed(0); return; }
      if (typeof d.lat === "number") {
        place(d.lat, d.lng, d.hdg);
        if (typeof d.spd === "number") setSpeed(d.spd);
        if (typeof d.dist === "number") setDist(d.dist);
        const now = Date.now();
        if (now - lastWindFetch > 10 * 60 * 1000) { lastWindFetch = now; fetchWind(d.lat, d.lng); }
      }
    } catch {}
  };
  ws.onclose = () => { if (relayBase) setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}

/* ---------- Twitch configuration ---------- */
function applyConfig() {
  try {
    const seg = window.Twitch.ext.configuration.broadcaster;
    if (!seg || !seg.content) return;
    const cfg = JSON.parse(seg.content);
    if (cfg.relay) { relayBase = cfg.relay.trim().replace(/\/+$/, ""); connect(); }
  } catch {}
}
// The overlay works out of the box via DEFAULT_RELAY (declared up top).
// Overridden by ?relay=<url> (local testing) or the broadcaster's saved config.
const relayParam = new URLSearchParams(location.search).get("relay");
relayBase = relayParam ? relayParam.replace(/\/+$/, "") : DEFAULT_RELAY;
connect();
if (window.Twitch && window.Twitch.ext) {
  window.Twitch.ext.onAuthorized(() => applyConfig());
  window.Twitch.ext.configuration.onChanged(() => applyConfig());
}

// Sync initial units display/label (e.g. a saved viewer preference). Safe here —
// all elements/functions are defined by now.
recomputeUnits();
