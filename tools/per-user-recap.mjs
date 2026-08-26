// tools/per-user-recap.mjs — loops the Strava recap flow over every user
// linked via tools/user-store.js, in addition to the captain's own
// single-account run in .github/workflows/strava-youtube-comment.yml.
// Reuses tools/strava-client.mjs, tools/road-matching.mjs, and
// tools/recap-writer.mjs exactly as the captain's own path does — the only
// new logic here is per-user iteration, LLM-key fallback, an idempotency
// marker, per-user failure isolation, and folding in each user's own
// dictated ride summary (POST /ride-summary -> userStore.getRideSummary(),
// cleared via clearRideSummary() after a successful write so it isn't
// reused next ride). See AGENTS.md.
//
// Deliberately does NOT touch YouTube: per the approved scope decision,
// YouTube video-linking stays captain-only (still lives only in the
// workflow's own heredoc). This only writes the Strava activity's
// title/description for each linked user, from their own latest activity —
// there is no YouTube video to gate on, so freshness/idempotency instead
// rely on RECAP_MARKER below.
//
// Strava's API rate limit is PER-APPLICATION (shared across every user this
// loop processes, since they all go through the same STRAVA_CLIENT_ID/
// SECRET), not per-athlete: roughly 100-200 requests/15min and 1000-2000/day
// on a standard app. Fine at beta scale (a handful of linked users x a
// handful of calls each, every 30 minutes), but a future scale-up should
// throttle/batch this loop rather than firing every user's requests
// back-to-back with no delay.
import { createStravaClient } from "./strava-client.mjs";
import { matchRoadNames } from "./road-matching.mjs";
import { buildRecapPrompt, generateRecap } from "./recap-writer.mjs";

// Appended to a written description so a later run (every 30 minutes) can
// tell this activity already got a per-user recap and skip it, the same
// role the "already has a youtube.com link" check plays in the captain path
// — there's no video link to check for here, so this is our own marker.
export const RECAP_MARKER = "— recap via SlipstreamIRL";

// Runs the recap flow for one linked user's latest Strava activity.
// Returns { ok: true, activityId } on a write (or what would have been
// written, in dryRun mode), or { ok: true, skipped: reason } when nothing
// needed doing. Throws on a genuine failure; a thrown error with
// `code === "STRAVA_AUTH_FAILURE"` specifically means the stored refresh
// token no longer works (revoked at Strava) — the caller uses that to
// decide whether to unlink, as opposed to any other failure.
export async function runRecapForUser({
  twitchId,
  userStore,
  clientId,
  clientSecret,
  fallbackAnthropicKey,
  mapboxToken,
  dryRun = false,
  stravaClient = createStravaClient(),
  log = console.log,
}) {
  const refreshToken = await userStore.getStravaRefreshToken(twitchId);
  if (!refreshToken) return { ok: true, skipped: "no strava refresh token on record" };

  let accessToken;
  try {
    accessToken = await stravaClient.refreshAccessToken({ clientId, clientSecret, refreshToken });
  } catch (err) {
    const authError = new Error(`Strava refresh failed for twitchId=${twitchId}: ${err.message}`);
    authError.code = "STRAVA_AUTH_FAILURE";
    throw authError;
  }

  const activity = await stravaClient.getTargetActivity(accessToken, "");
  if (!activity) return { ok: true, skipped: "no strava activity found" };

  const detail = await stravaClient.getActivityDetail(accessToken, activity.id);
  const description = detail.description || "";
  if (description.includes(RECAP_MARKER)) {
    return { ok: true, skipped: "activity already has a per-user recap" };
  }

  const mi = (detail.distance / 1609.344).toFixed(1);
  const totalMin = Math.round(detail.moving_time / 60);
  const timeStr = `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
  const ft = Math.round((detail.total_elevation_gain || 0) * 3.28084).toLocaleString("en-US");

  // Optional real-road-name matching — same non-fatal fallback as the
  // captain path: any failure here just leaves roadNames empty.
  let roadNames = [];
  if (mapboxToken) {
    try {
      const points = await stravaClient.getActivityLatLngStream(accessToken, activity.id);
      roadNames = await matchRoadNames(points, { mapboxToken });
    } catch (err) {
      log(`Road-name map matching failed for twitchId=${twitchId} (non-fatal): ${err.message}`);
    }
  }

  const anthropicKey = (await userStore.getAnthropicKey(twitchId)) || fallbackAnthropicKey || null;

  // The rider's own dictated post-ride summary (POST /ride-summary), if one
  // was recorded since the last recap — same riderNotes handling
  // recap-writer.mjs already applies for the captain's single-account path,
  // just sourced from the per-user store instead of RIDE_SUMMARY_JSON.
  const rideSummary = await userStore.getRideSummary(twitchId);
  const riderNotes = rideSummary && typeof rideSummary.summary === "string" && rideSummary.summary.trim()
    ? rideSummary.summary.trim()
    : null;

  let title = null;
  let hook = null;
  if (anthropicKey) {
    try {
      const segments = await stravaClient.rankSegmentsByPopularity(accessToken, detail.segment_efforts || []);
      const prompt = buildRecapPrompt({
        detail, mi, timeStr, ft, videoTitle: detail.name, segments, roadNames, riderNotes,
      });
      const result = await generateRecap({ prompt, apiKey: anthropicKey });
      if (result.ok) {
        if (result.title) title = result.title;
        if (result.opener) hook = result.opener;
        log(`Generated recap for twitchId=${twitchId}` + (riderNotes ? " (with rider notes)." : "."));
      } else {
        log(`Claude API error for twitchId=${twitchId} — writing stats-only recap: ${JSON.stringify(result.error)}`);
      }
    } catch (err) {
      log(`Claude call failed for twitchId=${twitchId} (non-fatal, writing stats-only recap): ${err.message}`);
    }
  }

  const statLine = `${mi} mi · ${timeStr} · ${ft} ft`;
  const parts = [];
  if (hook) parts.push(hook);
  parts.push(statLine);
  parts.push(RECAP_MARKER);
  const block = parts.join("\n\n");
  const newDescription = description ? `${description}\n\n${block}` : block;

  if (dryRun) {
    log(`[dry run] twitchId=${twitchId} would update Strava activity ${activity.id} (title: "${title || detail.name}")`);
    return { ok: true, activityId: activity.id, dryRun: true };
  }

  await stravaClient.updateActivity(accessToken, activity.id, { description: newDescription, name: title });

  // Consumed — clear it so a stale note isn't folded into the rider's next
  // ride, mirroring how the captain's single-account workflow step deletes
  // its ride-summary source after a successful write.
  if (riderNotes) {
    try {
      await userStore.clearRideSummary(twitchId);
    } catch (err) {
      log(`Failed to clear ride summary for twitchId=${twitchId} (non-fatal): ${err.message}`);
    }
  }

  return { ok: true, activityId: activity.id };
}

// Loops runRecapForUser() over every user tools/user-store.js's
// listLinkedUsers() returns. Each user is fully isolated: an auth failure
// unlinks that user and continues; any other failure is logged (naming the
// twitchId) and continues; neither aborts the loop or affects any other
// user, including the captain's own single-account run elsewhere in the
// workflow.
export async function runPerUserRecaps({
  userStore,
  clientId,
  clientSecret,
  fallbackAnthropicKey = null,
  mapboxToken = null,
  excludeAthleteId = null,
  dryRun = false,
  stravaClientFactory = createStravaClient,
  log = console.log,
}) {
  const summary = { processed: 0, skipped: 0, unlinked: 0, failed: 0 };

  let users;
  try {
    users = await userStore.listLinkedUsers();
  } catch (err) {
    log(`Per-user recap: failed to enumerate linked users (non-fatal, skipping per-user loop): ${err.message}`);
    return summary;
  }

  for (const user of users) {
    const twitchId = user.twitchId;

    if (excludeAthleteId != null && user.strava && String(user.strava.athleteId) === String(excludeAthleteId)) {
      log(`Per-user recap: skipping twitchId=${twitchId} — same Strava athlete id as the captain's own account, already covered by the single-account run.`);
      summary.skipped++;
      continue;
    }

    try {
      const result = await runRecapForUser({
        twitchId,
        userStore,
        clientId,
        clientSecret,
        fallbackAnthropicKey,
        mapboxToken,
        dryRun,
        stravaClient: stravaClientFactory(),
        log,
      });
      if (result.skipped) {
        summary.skipped++;
        log(`Per-user recap: twitchId=${twitchId} skipped — ${result.skipped}`);
      } else {
        summary.processed++;
        log(`Per-user recap: twitchId=${twitchId} ${dryRun ? "would update" : "updated"} Strava activity ${result.activityId}`);
      }
    } catch (err) {
      if (err.code === "STRAVA_AUTH_FAILURE") {
        summary.unlinked++;
        log(`Per-user recap: ${err.message} — treating as revoked, unlinking twitchId=${twitchId}.`);
        try {
          await userStore.deleteStravaLink(twitchId);
        } catch (delErr) {
          log(`Per-user recap: failed to delete stale Strava link for twitchId=${twitchId} (non-fatal): ${delErr.message}`);
        }
      } else {
        summary.failed++;
        log(`Per-user recap: twitchId=${twitchId} failed (non-fatal, continuing to next user): ${err.message}`);
      }
    }
  }

  return summary;
}
