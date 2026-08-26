// tools/road-matching.test.mjs — unit tests for tools/road-matching.mjs
// (GPS downsampling/chunking and Mapbox map-matching aggregation). Uses an
// injected fetchImpl stub throughout, never real network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { downsamplePoints, chunkPoints, matchRoadNames } from "./road-matching.mjs";

function jsonResponse(body, { ok = true } = {}) {
  return { ok, async json() { return body; } };
}

describe("downsamplePoints", () => {
  test("drops points closer than 25m to the last kept point, keeps the last point", () => {
    // ~0.0001 deg latitude is roughly 11m — below the 25m gap.
    const points = [
      [43.0, -110.0],
      [43.0001, -110.0], // too close, dropped
      [43.001, -110.0],  // far enough, kept
      [43.0011, -110.0], // too close to previous kept, dropped — but it's the last point so always kept
    ];
    const thinned = downsamplePoints(points);
    assert.equal(thinned[0], points[0]);
    assert.equal(thinned[thinned.length - 1], points[points.length - 1]);
    assert.ok(thinned.length < points.length);
  });

  test("fewer than 2 points passes through unchanged", () => {
    assert.deepEqual(downsamplePoints([]), []);
    assert.deepEqual(downsamplePoints([[1, 2]]), [[1, 2]]);
  });
});

describe("chunkPoints", () => {
  test("splits into chunks of the given size, last chunk may be shorter", () => {
    const points = Array.from({ length: 250 }, (_, i) => [i, i]);
    const chunks = chunkPoints(points, 100);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 100);
    assert.equal(chunks[1].length, 100);
    assert.equal(chunks[2].length, 50);
  });
});

describe("matchRoadNames", () => {
  test("returns [] when no mapboxToken is given", async () => {
    const names = await matchRoadNames([[1, 2], [3, 4]], { mapboxToken: "" });
    assert.deepEqual(names, []);
  });

  test("returns [] when fewer than 2 points are given", async () => {
    const names = await matchRoadNames([[1, 2]], { mapboxToken: "tok" });
    assert.deepEqual(names, []);
  });

  test("aggregates matched step names, ranked by distance, in ride order", async () => {
    const points = [[43.0, -110.0], [43.01, -110.0], [43.02, -110.0]];
    const fetchImpl = async () => jsonResponse({
      matchings: [{
        legs: [{
          steps: [
            { name: "Main St", distance: 100 },
            { name: "Side Rd", distance: 500 },
            { name: "", distance: 50 }, // unnamed step, dropped
          ],
        }],
      }],
    });
    const names = await matchRoadNames(points, { mapboxToken: "tok", fetchImpl });
    // Ride order preserved, not distance-sorted: "Main St" came first.
    assert.deepEqual(names, ["Main St", "Side Rd"]);
  });

  test("a chunk with a non-ok response is skipped, never throws", async () => {
    const points = [[43.0, -110.0], [43.01, -110.0]];
    const fetchImpl = async () => jsonResponse({}, { ok: false });
    const names = await matchRoadNames(points, { mapboxToken: "tok", fetchImpl });
    assert.deepEqual(names, []);
  });

  test("a chunk with no matchings is skipped, never throws", async () => {
    const points = [[43.0, -110.0], [43.01, -110.0]];
    const fetchImpl = async () => jsonResponse({ matchings: [] });
    const names = await matchRoadNames(points, { mapboxToken: "tok", fetchImpl });
    assert.deepEqual(names, []);
  });

  test("a network failure propagates (caller is responsible for the try/catch fallback)", async () => {
    const points = [[43.0, -110.0], [43.01, -110.0]];
    const fetchImpl = async () => { throw new Error("network down"); };
    await assert.rejects(() => matchRoadNames(points, { mapboxToken: "tok", fetchImpl }), /network down/);
  });
});
