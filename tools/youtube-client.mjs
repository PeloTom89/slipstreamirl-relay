// tools/youtube-client.mjs — YouTube Data API calls used by the
// Strava/YouTube recap workflow (.github/workflows/strava-youtube-comment.yml):
// latest-upload lookup, OAuth refresh, and mirroring the recap description
// onto the video itself. Extracted from what used to be an inline heredoc in
// that workflow — see AGENTS.md.
//
// apiBase/oauthBase/fetchImpl are test seams (default to the real YouTube/
// Google OAuth hosts) — do not document them in README.md's operator-facing
// env var tables, per AGENTS.md's existing TWITCH_HELIX_BASE/STRIPE_API_BASE
// note.
export function createYoutubeClient({
  apiBase = "https://www.googleapis.com/youtube/v3",
  oauthBase = "https://oauth2.googleapis.com",
  fetchImpl = fetch,
} = {}) {
  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  // Finds the most recent video uploaded to channelId after sinceIso, or
  // null if none. Throws on a YouTube API error response.
  async function findRecentVideo({ apiKey, channelId, sinceIso }) {
    const res = await fetchImpl(
      `${apiBase}/search?part=snippet` +
      `&channelId=${encodeURIComponent(channelId)}` +
      `&type=video&order=date&maxResults=1` +
      `&publishedAfter=${encodeURIComponent(sinceIso)}` +
      `&key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json();
    if (data.error) {
      throw new Error('YouTube API error: ' + JSON.stringify(data.error));
    }
    const video = (data.items || [])[0];
    if (!video) return null;
    return {
      videoId: video.id.videoId,
      publishedAt: video.snippet.publishedAt,
      title: decodeEntities(video.snippet.title || '').trim(),
    };
  }

  async function refreshOAuthToken({ clientId, clientSecret, refreshToken }) {
    const res = await fetchImpl(`${oauthBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await res.json();
    if (!data.access_token) {
      throw new Error('YouTube OAuth refresh failed: ' + JSON.stringify(data));
    }
    return data.access_token;
  }

  // videos.update requires resending the whole snippet (title/categoryId/
  // etc.) or YouTube silently clears the fields not included — callers must
  // fetch it first via this and spread it back in on update.
  async function getVideoSnippet(accessToken, videoId) {
    const res = await fetchImpl(
      `${apiBase}/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json();
    const snippet = (data.items || [])[0]?.snippet;
    if (!snippet) {
      throw new Error('Could not fetch current YouTube video snippet.');
    }
    return snippet;
  }

  async function updateVideoDescription(accessToken, videoId, currentSnippet, description) {
    const res = await fetchImpl(`${apiBase}/videos?part=snippet`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: videoId,
        snippet: { ...currentSnippet, description },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`YouTube videos.update failed (${res.status}): ${errBody}`);
    }
  }

  return { findRecentVideo, refreshOAuthToken, getVideoSnippet, updateVideoDescription };
}
