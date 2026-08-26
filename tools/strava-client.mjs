// tools/strava-client.mjs — Strava API calls used by the Strava/YouTube recap
// workflow (.github/workflows/strava-youtube-comment.yml): token refresh,
// activity lookup/detail, GPS stream fetch, segment-popularity ranking, and
// the description/title write-back. Extracted from what used to be an inline
// heredoc in that workflow — see AGENTS.md.
//
// apiBase/oauthBase/fetchImpl are test seams (default to the real Strava
// hosts) — do not document them in README.md's operator-facing env var
// tables, per AGENTS.md's existing TWITCH_HELIX_BASE/STRIPE_API_BASE note.
export function createStravaClient({
  apiBase = "https://www.strava.com/api/v3",
  oauthBase = "https://www.strava.com/oauth",
  fetchImpl = fetch,
} = {}) {
  async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
    const res = await fetchImpl(`${oauthBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error("Strava token refresh failed: " + JSON.stringify(data));
    }
    return data.access_token;
  }

  // The currently-authenticated athlete's own profile (includes `id`). Used
  // by the per-user recap loop (tools/per-user-recap.mjs) to resolve the
  // captain's own Strava athlete id for dedupe against the per-user store —
  // see AGENTS.md.
  async function getAuthenticatedAthlete(accessToken) {
    const res = await fetchImpl(`${apiBase}/athlete`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Strava athlete fetch failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async function listRecentActivities(accessToken, perPage = 10) {
    const res = await fetchImpl(`${apiBase}/athlete/activities?per_page=${perPage}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Strava activities fetch failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  // A specific activity if activityIdOverride is set (manual re-apply),
  // otherwise whatever's currently latest.
  async function getTargetActivity(accessToken, activityIdOverride) {
    const res = await fetchImpl(
      activityIdOverride
        ? `${apiBase}/activities/${activityIdOverride}`
        : `${apiBase}/athlete/activities?per_page=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      throw new Error(`Strava activities fetch failed (${res.status}): ${await res.text()}`);
    }
    const body = await res.json();
    return activityIdOverride ? body : (body || [])[0];
  }

  async function getActivityDetail(accessToken, activityId) {
    const res = await fetchImpl(`${apiBase}/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Strava activity fetch failed (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  // Returns [] on any non-ok response or missing data — this feeds the
  // optional road-name map-matching path, which must never block the rest of
  // the recap pipeline.
  async function getActivityLatLngStream(accessToken, activityId) {
    const res = await fetchImpl(
      `${apiBase}/activities/${activityId}/streams?keys=latlng&key_by_type=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.latlng && data.latlng.data) || [];
  }

  async function getSegmentAthleteCount(accessToken, segmentId) {
    try {
      const res = await fetchImpl(`${apiBase}/segments/${segmentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return 0;
      const detail = await res.json();
      return detail.athlete_count || 0;
    } catch {
      return 0;
    }
  }

  // Ranks segments by Strava's own athlete_count (unique riders who've ever
  // done it) rather than ride order, so well-known segments surface first
  // instead of one-off/junk auto-generated ones. Dedupes by segment id
  // first, capped to bound API calls.
  async function rankSegmentsByPopularity(accessToken, segmentEfforts, { limit = 6, candidateCap = 15 } = {}) {
    const segmentIdPairs = [...new Map(
      (segmentEfforts || [])
        .filter((e) => e.segment && e.segment.id)
        .map((e) => [e.segment.id, e.segment_name || e.segment.name])
    ).entries()].slice(0, candidateCap);
    const segmentPopularity = await Promise.all(
      segmentIdPairs.map(async ([id, name]) => ({
        name,
        athleteCount: await getSegmentAthleteCount(accessToken, id),
      }))
    );
    return segmentPopularity
      .sort((a, b) => b.athleteCount - a.athleteCount)
      .slice(0, limit)
      .map((s) => s.name)
      .filter(Boolean);
  }

  async function updateActivity(accessToken, activityId, { description, name }) {
    const updateBody = { description };
    if (name) updateBody.name = name;
    const res = await fetchImpl(`${apiBase}/activities/${activityId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(updateBody).toString(),
    });
    if (!res.ok) {
      throw new Error(`Strava activity update failed (${res.status}): ${await res.text()}`);
    }
    return res;
  }

  return {
    refreshAccessToken,
    getAuthenticatedAthlete,
    listRecentActivities,
    getTargetActivity,
    getActivityDetail,
    getActivityLatLngStream,
    rankSegmentsByPopularity,
    updateActivity,
  };
}
