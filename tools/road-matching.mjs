// tools/road-matching.mjs — GPS-trace-to-road-name matching for the
// Strava/YouTube recap workflow, via Mapbox's Map Matching API. Downsamples
// and chunks a raw lat/lng breadcrumb trail, matches it against Mapbox, and
// consolidates the resulting step names through tools/road-names.mjs's
// aggregation (already extracted there — consolidated per AGENTS.md).
//
// Every failure here is meant to be non-fatal to the caller — a rejected
// chunk is just skipped — but this module does not itself swallow a hard
// failure (e.g. the fetch rejecting outright); the caller
// (.github/workflows/strava-youtube-comment.yml) wraps the whole call in a
// try/catch and falls back to segments-only, same as before extraction.
import { aggregateRoadNames, topRoadNamesInRideOrder } from "./road-names.mjs";

// Keep a point only once it's >=25m from the last kept point (same
// decimation distance the relay's own breadcrumb trail uses) — thousands of
// raw GPS points is far more than needed to trace the route shape.
const MIN_GAP_M = 25;
// Mapbox caps requests at 100 coordinates.
const MAPBOX_CHUNK = 100;

function haversineM(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat = (((a[0] + b[0]) / 2) * Math.PI) / 180;
  const x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

export function downsamplePoints(points, minGapM = MIN_GAP_M) {
  if (points.length < 2) return points.slice();
  const thinned = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (haversineM(thinned[thinned.length - 1], points[i]) >= minGapM) thinned.push(points[i]);
  }
  const last = points[points.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);
  return thinned;
}

export function chunkPoints(points, size = MAPBOX_CHUNK) {
  const chunks = [];
  for (let i = 0; i < points.length; i += size) chunks.push(points.slice(i, i + size));
  return chunks;
}

async function matchChunk(chunk, { mapboxToken, apiBase, fetchImpl }) {
  if (chunk.length < 2) return [];
  const coordStr = chunk.map(([lat, lng]) => `${lng},${lat}`).join(";");
  // A generous 25m match radius per point — real GPS traces (especially
  // under tree cover / in canyons) wander more than Mapbox's tight default,
  // and a rejected match is worse than a slightly loose one.
  const radiusStr = chunk.map(() => "25").join(";");
  const url =
    `${apiBase}/matching/v5/mapbox/cycling/${coordStr}` +
    `?access_token=${encodeURIComponent(mapboxToken)}&steps=true&geometries=geojson` +
    `&overview=false&radiuses=${radiusStr}`;
  const res = await fetchImpl(url);
  if (!res.ok) return []; // skip this chunk, never fail the run over it
  const data = await res.json();
  const matching = (data.matchings || [])[0];
  if (!matching) return [];
  const steps = [];
  for (const leg of matching.legs || []) {
    for (const step of leg.steps || []) {
      const name = (step.name || "").trim();
      if (!name) continue;
      steps.push({ name, distance: step.distance || 0 });
    }
  }
  return steps;
}

// Matches a raw [lat,lng] point list against Mapbox, returning road names in
// the order actually ridden, ranked by distance covered (see
// tools/road-names.mjs for the aggregation/ranking rules). Returns [] if
// there aren't enough points or no mapboxToken is given — callers still
// decide whether to attempt this at all based on MAPBOX_TOKEN being
// configured, matching the pre-extraction behavior.
export async function matchRoadNames(points, {
  mapboxToken,
  apiBase = "https://api.mapbox.com",
  fetchImpl = fetch,
  limit = 8,
} = {}) {
  if (!mapboxToken || !points || points.length < 2) return [];
  const thinned = downsamplePoints(points);
  const chunks = chunkPoints(thinned);
  const roadSteps = [];
  for (const chunk of chunks) {
    const steps = await matchChunk(chunk, { mapboxToken, apiBase, fetchImpl });
    roadSteps.push(...steps);
  }
  const roadGroups = aggregateRoadNames(roadSteps);
  return topRoadNamesInRideOrder(roadGroups, limit);
}
