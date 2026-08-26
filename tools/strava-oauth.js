// tools/strava-oauth.js — Strava's OAuth authorization-code flow: authorize
// URL construction, code->token exchange, refresh, and deauthorize (revoke).
// CommonJS for the same server.js-require()s-this-synchronously reason as
// channel-token.js/stripe-entitlement.js/user-store.js — see AGENTS.md.
//
// All three Strava endpoints used here (authorize, token, deauthorize) live
// under the one https://www.strava.com/oauth path, so STRAVA_OAUTH_BASE (a
// base-URL test seam, same convention as
// TWITCH_HELIX_BASE/STRIPE_API_BASE/UPSTASH_API_BASE — not documented in
// README's operator-facing env var tables) is the only base this module
// needs. There is deliberately no STRAVA_API_BASE: nothing here calls
// api.strava.com (activity data belongs to the separate, not-yet-built
// recap-consuming follow-up that will read the refresh token this module
// helps produce).
//
// Strava's /oauth/token and /oauth/deauthorize endpoints take standard
// form-encoded POST bodies (see Strava's own curl examples in their API
// docs), matching the style stripe-entitlement.js already uses for its one
// write call.

const STRAVA_SCOPE = "activity:read_all,activity:write";

function buildAuthorizeUrl({ clientId, redirectUri, state, oauthBase }) {
  if (!clientId) throw new Error("clientId required");
  if (!redirectUri) throw new Error("redirectUri required");
  if (!state) throw new Error("state required");
  const url = new URL(oauthBase + "/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", STRAVA_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

async function postForm(oauthBase, fetchImpl, params) {
  const r = await fetchImpl(oauthBase + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!r.ok) throw new Error("strava /oauth/token failed: " + r.status);
  return r.json();
}

// -> { access_token, refresh_token, expires_at, athlete: {id, ...} }
async function exchangeCode({ clientId, clientSecret, code, oauthBase, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error("clientId/clientSecret required");
  if (!code) throw new Error("code required");
  return postForm(oauthBase, fetchImpl, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
  });
}

// -> { access_token, refresh_token, expires_at } — no `athlete` on a refresh.
async function refreshAccessToken({ clientId, clientSecret, refreshToken, oauthBase, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error("clientId/clientSecret required");
  if (!refreshToken) throw new Error("refreshToken required");
  return postForm(oauthBase, fetchImpl, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}

async function deauthorize({ accessToken, oauthBase, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("accessToken required");
  const r = await fetchImpl(oauthBase + "/deauthorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: accessToken }).toString(),
  });
  if (!r.ok) throw new Error("strava /oauth/deauthorize failed: " + r.status);
}

module.exports = { STRAVA_SCOPE, buildAuthorizeUrl, exchangeCode, refreshAccessToken, deauthorize };
