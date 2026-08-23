// Aggregates Mapbox map-matching step names into de-duplicated, ranked road
// names for the Strava/YouTube write-up. The same physical road can come back
// from Mapbox as two entries when different stretches are tagged with
// slightly different strings — most commonly a trailing highway/route
// designation, e.g. "Moose-Wilson Road" vs "Moose-Wilson Road (WY 390)".
// Left unmerged, that splits the distance credit between the two spellings
// and burns two of the top-8 ranked slots on what is really one road.
//
// Normalization here is for GROUPING ONLY — the name shown to the reader is
// always one of the actual variants seen (the shortest one), never a
// mangled key.

// Matches a trailing parenthetical that looks like a highway/route
// designation: either a short alpha prefix + number (state postal code style,
// e.g. "(WY 390)", "(US-26)") or a route word + number (e.g.
// "(County Road 22)", "(Highway 89)"). Intentionally narrow: a parenthetical
// with no digits, or one that doesn't match a route-ish prefix, is left
// alone rather than risk merging two genuinely different named things that
// happen to share a prefix (e.g. "Main Street" vs "Main Street North" have no
// parenthetical at all and are never touched by this).
const ROUTE_WORD =
  "(?:interstate|state\\s*route|state\\s*highway|county\\s*road|farm-to-market\\s*road|farm\\s*road|us\\s*highway|us\\s*route|highway|hwy|route|rt)";
const HIGHWAY_PAREN_RE = new RegExp(
  `\\s*\\(\\s*(?:${ROUTE_WORD}\\.?\\s*-?\\s*\\d+[a-z]?|[a-z]{1,3}\\s*-?\\s*\\d+[a-z]?)\\s*\\)\\s*$`,
  "i"
);

export function stripHighwaySuffix(name) {
  return name.replace(HIGHWAY_PAREN_RE, "").trim();
}

export function normalizeRoadKey(name) {
  return stripHighwaySuffix(name).toLowerCase().replace(/\s+/g, " ").trim();
}

// Groups { name, distance } steps (in ride order) by normalized key, summing
// distance across variants of the same road. Keeps the shortest-seen variant
// as the display name for each group — when a bare form (no highway suffix)
// was seen, it's the shortest and wins; if only suffixed variants exist, the
// shorter of those is preferred over a longer one.
export function aggregateRoadNames(steps) {
  const groups = new Map(); // normalized key -> { display, distance, order }
  let order = 0;
  for (const { name, distance } of steps) {
    const trimmedName = (name || "").trim();
    if (!trimmedName) continue;
    const key = normalizeRoadKey(trimmedName);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.distance += distance || 0;
      if (trimmedName.length < existing.display.length) existing.display = trimmedName;
    } else {
      groups.set(key, { display: trimmedName, distance: distance || 0, order: order++ });
    }
  }
  return groups;
}

// Selects the top `limit` groups by total distance covered (so a minor
// service road doesn't crowd out the ones that actually defined the ride),
// then returns their display names in the order they were actually ridden —
// NOT sorted by distance — so the write-up doesn't misrepresent which road
// came first (a road ridden last but for the longest stretch would otherwise
// sort to the top of the list).
export function topRoadNamesInRideOrder(groups, limit = 8) {
  const topKeys = new Set(
    [...groups.entries()]
      .sort((a, b) => b[1].distance - a[1].distance)
      .slice(0, limit)
      .map(([key]) => key)
  );
  return [...groups.entries()]
    .filter(([key]) => topKeys.has(key))
    .sort((a, b) => a[1].order - b[1].order)
    .map(([, group]) => group.display);
}
