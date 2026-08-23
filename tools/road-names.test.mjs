import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripHighwaySuffix,
  normalizeRoadKey,
  aggregateRoadNames,
  topRoadNamesInRideOrder,
} from "./road-names.mjs";

test("strips the roadmap's example highway suffix", () => {
  assert.equal(stripHighwaySuffix("Moose-Wilson Road (WY 390)"), "Moose-Wilson Road");
});

test("normalized keys match across the highway-suffix variant and the bare name", () => {
  assert.equal(
    normalizeRoadKey("Moose-Wilson Road"),
    normalizeRoadKey("Moose-Wilson Road (WY 390)")
  );
});

test("merges the roadmap's example and sums distance, keeping the clean display name", () => {
  const groups = aggregateRoadNames([
    { name: "Moose-Wilson Road", distance: 1200 },
    { name: "Moose-Wilson Road (WY 390)", distance: 800 },
  ]);
  assert.equal(groups.size, 1);
  const [group] = groups.values();
  assert.equal(group.display, "Moose-Wilson Road");
  assert.equal(group.distance, 2000);
});

test("sums distance across more than two variants of the same road", () => {
  const groups = aggregateRoadNames([
    { name: "Teton Village Road", distance: 500 },
    { name: "Teton Village Road (WY 390)", distance: 300 },
    { name: "Teton Village Road (WY 390)", distance: 400 },
  ]);
  assert.equal(groups.size, 1);
  const [group] = groups.values();
  assert.equal(group.distance, 1200);
  assert.equal(group.display, "Teton Village Road");
});

test("does NOT merge genuinely distinct roads that share a prefix", () => {
  const groups = aggregateRoadNames([
    { name: "Main Street", distance: 500 },
    { name: "Main Street North", distance: 300 },
  ]);
  assert.equal(groups.size, 2);
  const displays = [...groups.values()].map((g) => g.display).sort();
  assert.deepEqual(displays, ["Main Street", "Main Street North"]);
});

test("does NOT strip a parenthetical with no route-like digits", () => {
  const groups = aggregateRoadNames([
    { name: "Teton Park Road", distance: 500 },
    { name: "Teton Park Road (Inner Park Loop)", distance: 300 },
  ]);
  assert.equal(groups.size, 2);
});

test("a merged road ranks correctly in the top-N even when no single variant would have", () => {
  // Two variants of the same road, individually smaller than a rival road,
  // but combined they should outrank it and take the single top-1 slot.
  const groups = aggregateRoadNames([
    { name: "Spring Gulch Road", distance: 600 },
    { name: "Spring Gulch Road (WY 22)", distance: 600 },
    { name: "Fish Creek Road", distance: 1000 },
  ]);
  const top1 = topRoadNamesInRideOrder(groups, 1);
  assert.deepEqual(top1, ["Spring Gulch Road"]);
});

test("top-N output preserves ride order, not distance order", () => {
  const groups = aggregateRoadNames([
    { name: "Road A", distance: 100 },
    { name: "Road B", distance: 900 },
    { name: "Road C", distance: 500 },
  ]);
  const top = topRoadNamesInRideOrder(groups, 8);
  assert.deepEqual(top, ["Road A", "Road B", "Road C"]);
});

test("top-N caps the number of roads returned", () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({
    name: `Road ${i}`,
    distance: i + 1,
  }));
  const groups = aggregateRoadNames(steps);
  const top = topRoadNamesInRideOrder(groups, 8);
  assert.equal(top.length, 8);
});

test("blank/whitespace-only names are ignored", () => {
  const groups = aggregateRoadNames([
    { name: "", distance: 100 },
    { name: "   ", distance: 100 },
    { name: "Real Road", distance: 100 },
  ]);
  assert.equal(groups.size, 1);
});
