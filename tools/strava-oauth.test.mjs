// tools/strava-oauth.test.mjs — unit tests for the Strava OAuth helpers
// against a local stub HTTP server standing in for Strava's /oauth endpoints
// (mirrors user-store.test.mjs's Upstash stub). No live Strava credentials
// used anywhere here.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken, deauthorize } from "./strava-oauth.js";

function startStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
  });
}

describe("buildAuthorizeUrl", () => {
  const oauthBase = "https://www.strava.com/oauth";

  test("builds a well-formed authorize URL with the required params", () => {
    const url = new URL(buildAuthorizeUrl({
      clientId: "12345",
      redirectUri: "https://relay.example/strava-callback",
      state: "signed-state-token",
      oauthBase,
    }));
    assert.equal(url.origin + url.pathname, "https://www.strava.com/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "12345");
    assert.equal(url.searchParams.get("redirect_uri"), "https://relay.example/strava-callback");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "signed-state-token");
    assert.equal(url.searchParams.get("scope"), "activity:read_all,activity:write");
  });

  test("requires clientId, redirectUri, and state", () => {
    assert.throws(() => buildAuthorizeUrl({ redirectUri: "x", state: "y", oauthBase }));
    assert.throws(() => buildAuthorizeUrl({ clientId: "x", state: "y", oauthBase }));
    assert.throws(() => buildAuthorizeUrl({ clientId: "x", redirectUri: "y", oauthBase }));
  });
});

describe("exchangeCode / refreshAccessToken / deauthorize against a stub Strava", () => {
  let stub, requests, tokenResponse, tokenStatus, deauthStatus;
  let baseUrl;

  before(async () => {
    stub = await startStub(async (req, res) => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/token") {
        res.writeHead(tokenStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tokenResponse));
        return;
      }
      if (req.url === "/deauthorize") {
        res.writeHead(deauthStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: new URLSearchParams(body).get("access_token") }));
        return;
      }
      res.writeHead(404); res.end("not found in stub");
    });
    baseUrl = `http://127.0.0.1:${stub.address().port}`;
  });

  after(async () => { await new Promise((r) => stub.close(r)); });

  beforeEach(() => {
    requests = [];
    tokenStatus = 200;
    deauthStatus = 200;
    tokenResponse = {
      access_token: "access-abc",
      refresh_token: "refresh-abc",
      expires_at: 1_700_000_000,
      athlete: { id: 999 },
    };
  });

  test("exchangeCode posts form-encoded grant_type=authorization_code and returns the parsed tokens", async () => {
    const result = await exchangeCode({
      clientId: "cid", clientSecret: "csecret", code: "auth-code-xyz", oauthBase: baseUrl,
    });
    assert.equal(result.access_token, "access-abc");
    assert.equal(result.refresh_token, "refresh-abc");
    assert.equal(result.athlete.id, 999);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers["content-type"], "application/x-www-form-urlencoded");
    const sent = new URLSearchParams(requests[0].body);
    assert.equal(sent.get("client_id"), "cid");
    assert.equal(sent.get("client_secret"), "csecret");
    assert.equal(sent.get("code"), "auth-code-xyz");
    assert.equal(sent.get("grant_type"), "authorization_code");
  });

  test("exchangeCode throws on a non-2xx response, rather than returning a bogus token", async () => {
    tokenStatus = 400;
    tokenResponse = { message: "Bad Request", errors: [] };
    await assert.rejects(() => exchangeCode({ clientId: "cid", clientSecret: "csecret", code: "bad-code", oauthBase: baseUrl }));
  });

  test("refreshAccessToken posts form-encoded grant_type=refresh_token", async () => {
    const result = await refreshAccessToken({
      clientId: "cid", clientSecret: "csecret", refreshToken: "refresh-abc", oauthBase: baseUrl,
    });
    assert.equal(result.access_token, "access-abc");
    const sent = new URLSearchParams(requests[0].body);
    assert.equal(sent.get("grant_type"), "refresh_token");
    assert.equal(sent.get("refresh_token"), "refresh-abc");
  });

  test("refreshAccessToken throws on a non-2xx response (e.g. a revoked refresh token)", async () => {
    tokenStatus = 401;
    tokenResponse = { message: "Unauthorized" };
    await assert.rejects(() => refreshAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "dead", oauthBase: baseUrl }));
  });

  test("deauthorize posts the access token form-encoded to /deauthorize", async () => {
    await deauthorize({ accessToken: "access-abc", oauthBase: baseUrl });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/deauthorize");
    const sent = new URLSearchParams(requests[0].body);
    assert.equal(sent.get("access_token"), "access-abc");
  });

  test("deauthorize throws on a non-2xx response", async () => {
    deauthStatus = 500;
    await assert.rejects(() => deauthorize({ accessToken: "access-abc", oauthBase: baseUrl }));
  });

  test("exchangeCode/refreshAccessToken/deauthorize require their core arguments", async () => {
    await assert.rejects(() => exchangeCode({ clientId: "cid", clientSecret: "csecret", oauthBase: baseUrl }));
    await assert.rejects(() => refreshAccessToken({ clientId: "cid", clientSecret: "csecret", oauthBase: baseUrl }));
    await assert.rejects(() => deauthorize({ oauthBase: baseUrl }));
  });
});
