// tools/relay-server.test.mjs — integration tests for server.js's MULTI_TENANT
// mode, run against a real spawned instance of the relay (not a mock), because
// the property being verified is what an actual client sees over the wire.
//
// broadcast()/emit() rebuild every payload rather than forwarding it, and
// channelizing them is exactly where a message can silently reach the wrong
// channel's overlays (or none) — see README.md/ROADMAP.md. These tests exist
// to make that class of bug fail loudly: every protocol message type is
// checked to reach only its own channel's overlay and never a sibling
// channel's, with two channels live at once. A second suite proves
// MULTI_TENANT unset reproduces the original single-tenant behaviour exactly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { signChannelToken } from "./channel-token.js";
import { startServer } from "./spawn-relay.mjs";

function openOverlay(baseWs, channel) {
  return new Promise((resolve, reject) => {
    const url = baseWs + "/?role=overlay" + (channel ? "&channel=" + encodeURIComponent(channel) : "");
    const ws = new WebSocket(url);
    const messages = [];
    ws.on("message", (buf) => { messages.push(JSON.parse(buf.toString())); });
    ws.once("open", () => resolve({ ws, messages }));
    ws.once("error", reject);
  });
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve({ code }));
  });
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() >= deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// A grace window to prove a message did NOT arrive somewhere it shouldn't —
// distinct from waitFor, which only proves something DID arrive.
const LEAK_GRACE_MS = 150;

describe("multi-tenant mode (MULTI_TENANT=1)", () => {
  let server;
  const SECRET = "test-jwt-secret-please-ignore";

  before(async () => {
    server = await startServer({ MULTI_TENANT: "1", RELAY_JWT_SECRET: SECRET });
  });
  after(async () => { await server.stop(); });

  function tokenFor(channel) {
    return signChannelToken(channel, SECRET);
  }

  async function push(channel, body, token = tokenFor(channel)) {
    return fetch(`${server.baseHttp}/push?channel=${encodeURIComponent(channel)}&token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Every channel starts at the production default delayMs (4500ms), which
  // would make these tests slow and flaky. Zeroing it per test channel is
  // itself exercising real protocol behaviour (the app does this too).
  async function zeroDelay(channel) {
    const res = await push(channel, { delay: 0 });
    assert.equal(res.status, 200);
  }

  // One case per protocol message type from README.md/ROADMAP.md's table
  // (excluding {delay}, which is never forwarded to overlays at all, and
  // {path}, which is a server-generated replay-only message, not something a
  // sender pushes — both covered by dedicated tests below instead).
  const MESSAGE_CASES = [
    {
      name: "position fix",
      body: { lat: 47.5, lng: -110.2, acc: 5, hdg: 90, spd: 3.1, dist: 120 },
      match: (m) => m.lat === 47.5 && m.lng === -110.2,
    },
    { name: "hidden heartbeat", body: { hidden: true }, match: (m) => m.hidden === true },
    { name: "offline", body: { offline: true }, match: (m) => m.offline === true },
    { name: "wind toggle", body: { wind: true }, match: (m) => m.wind === true },
    { name: "units", body: { units: "metric" }, match: (m) => m.units === "metric" },
    {
      name: "BLE sensors",
      body: { power: 210, cadence: 88, hr: 150 },
      match: (m) => m.power === 210 && m.cadence === 88 && m.hr === 150,
    },
    {
      name: "effort zones",
      body: { zones: { ftp: 250, lthr: 165, maxhr: 190, cadence: 90, speed: 30 } },
      match: (m) => m.zones && m.zones.ftp === 250,
    },
    {
      name: "Varia radar",
      body: { radar: [{ speed: 5, dist: 100, threat: 1 }] },
      match: (m) => Array.isArray(m.radar) && m.radar[0] && m.radar[0].dist === 100,
    },
    { name: "liveStart", body: { liveStart: 1_800_000_000_000 }, match: (m) => m.liveStart === 1_800_000_000_000 },
  ];

  MESSAGE_CASES.forEach(({ name, body, match }, i) => {
    test(`cross-channel isolation: ${name} reaches only its channel's overlay`, async () => {
      const channelA = `iso-a-${i}`;
      const channelB = `iso-b-${i}`;
      await zeroDelay(channelA);
      await zeroDelay(channelB);
      const a = await openOverlay(server.baseWs, channelA);
      const b = await openOverlay(server.baseWs, channelB);

      const res = await push(channelA, body);
      assert.equal(res.status, 200);
      await waitFor(() => a.messages.some(match));
      await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));
      assert.ok(!b.messages.some(match), `sibling channel received "${name}" meant for another channel`);

      a.ws.close();
      b.ws.close();
    });
  });

  test("{delay} is never forwarded to any overlay", async () => {
    const channel = "delay-config-only";
    const a = await openOverlay(server.baseWs, channel);
    const res = await push(channel, { delay: 0.25 });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));
    assert.equal(a.messages.length, 0, "{delay} config messages must not reach overlays");
    a.ws.close();
  });

  test("two channels active simultaneously each receive only their own traffic", async () => {
    const A = "simul-a", B = "simul-b";
    await zeroDelay(A);
    await zeroDelay(B);
    const a = await openOverlay(server.baseWs, A);
    const b = await openOverlay(server.baseWs, B);

    await Promise.all([push(A, { lat: 1, lng: 1 }), push(B, { lat: 2, lng: 2 })]);
    await waitFor(() => a.messages.some((m) => m.lat === 1));
    await waitFor(() => b.messages.some((m) => m.lat === 2));

    await Promise.all([push(A, { wind: true }), push(B, { wind: false })]);
    await waitFor(() => a.messages.some((m) => m.wind === true));
    await waitFor(() => b.messages.some((m) => m.wind === false));

    await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));
    assert.ok(!a.messages.some((m) => m.lat === 2), "A saw B's position fix");
    assert.ok(!b.messages.some((m) => m.lat === 1), "B saw A's position fix");
    assert.ok(!a.messages.some((m) => m.wind === false), "A saw B's wind state");
    assert.ok(!b.messages.some((m) => m.wind === true), "B saw A's wind state");

    a.ws.close();
    b.ws.close();
  });

  test("late-joining overlay replays only its own channel's cached state", async () => {
    const channelA = "late-a", channelB = "late-b";
    await zeroDelay(channelA);
    await zeroDelay(channelB);
    await push(channelA, { lat: 10, lng: 20 });
    await push(channelA, { wind: true });
    await push(channelA, { zones: { ftp: 200 } });
    await push(channelB, { lat: 99, lng: 99 });
    await push(channelB, { wind: false });
    await new Promise((r) => setTimeout(r, 100));

    const late = await openOverlay(server.baseWs, channelA);
    await waitFor(() => late.messages.length >= 3);
    await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));

    assert.ok(late.messages.some((m) => m.lat === 10 && m.lng === 20), "missing own channel's replayed position");
    assert.ok(late.messages.some((m) => m.wind === true), "missing own channel's replayed wind state");
    assert.ok(late.messages.some((m) => m.zones && m.zones.ftp === 200), "missing own channel's replayed zones");
    assert.ok(!late.messages.some((m) => m.lat === 99), "leaked the other channel's replayed position");
    assert.ok(!late.messages.some((m) => m.wind === false), "leaked the other channel's replayed wind state");

    late.ws.close();
  });

  test("late-joining overlay replays the per-channel breadcrumb path, not a sibling's", async () => {
    const channelA = "late-path-a", channelB = "late-path-b";
    await zeroDelay(channelA);
    await zeroDelay(channelB);
    // TRAIL_MIN_M is 25m, so these need to be far enough apart to record.
    await push(channelA, { lat: 40.0, lng: -105.0 });
    await push(channelA, { lat: 40.01, lng: -105.0 });
    await push(channelB, { lat: 50.0, lng: -110.0 });
    await new Promise((r) => setTimeout(r, 100));

    const late = await openOverlay(server.baseWs, channelA);
    await waitFor(() => late.messages.some((m) => Array.isArray(m.path)));
    const pathMsg = late.messages.find((m) => Array.isArray(m.path));
    assert.ok(pathMsg.path.some((pt) => pt[0] === 40.0), "own channel's path missing");
    assert.ok(!pathMsg.path.some((pt) => pt[0] === 50.0), "leaked sibling channel's path point");

    late.ws.close();
  });

  test("push with no channel is rejected", async () => {
    const token = tokenFor("some-channel");
    const res = await fetch(`${server.baseHttp}/push?token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 400);
  });

  test("push with a token minted for a different channel is rejected", async () => {
    const token = tokenFor("channel-y");
    const res = await push("channel-z", { lat: 1, lng: 1 }, token);
    assert.equal(res.status, 403);
  });

  test("push with a garbage token is rejected", async () => {
    const res = await fetch(`${server.baseHttp}/push?channel=chan&token=not-a-jwt`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  test("overlay WS with no channel is closed", async () => {
    const ws = new WebSocket(server.baseWs + "/?role=overlay");
    const { code } = await waitForClose(ws);
    assert.equal(code, 1008);
  });

  test("sender WS with no valid channel token is closed, and never mutates any channel", async () => {
    const channel = "ws-guard";
    const overlay = await openOverlay(server.baseWs, channel);
    const badWs = new WebSocket(`${server.baseWs}/?role=sender&channel=${channel}&token=garbage`);
    const { code } = await waitForClose(badWs);
    assert.equal(code, 1008);
    await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));
    assert.equal(overlay.messages.length, 0);
    overlay.ws.close();
  });

  test("WS sender push isolates by channel the same way HTTP push does", async () => {
    const A = "ws-sender-a", B = "ws-sender-b";
    await zeroDelay(A);
    await zeroDelay(B);
    const a = await openOverlay(server.baseWs, A);
    const b = await openOverlay(server.baseWs, B);

    const senderA = new WebSocket(`${server.baseWs}/?role=sender&channel=${A}&token=${encodeURIComponent(tokenFor(A))}`);
    await waitForOpen(senderA);
    senderA.send(JSON.stringify({ lat: 3, lng: 4 }));

    await waitFor(() => a.messages.some((m) => m.lat === 3));
    await new Promise((r) => setTimeout(r, LEAK_GRACE_MS));
    assert.ok(!b.messages.some((m) => m.lat === 3), "WS sender push leaked to another channel");

    senderA.close();
    a.ws.close();
    b.ws.close();
  });

  async function channelCount() {
    const text = await fetch(`${server.baseHttp}/`).then((r) => r.text());
    return Number(text.match(/multi-tenant, (\d+) channel/)[1]);
  }

  test("overlay WS to a never-pushed channel is closed, and does not persist a channel entry", async () => {
    const channel = "peek-only-channel";
    const beforeCount = await channelCount();

    const ws = new WebSocket(server.baseWs + "/?role=overlay&channel=" + encodeURIComponent(channel));
    const { code } = await waitForClose(ws);
    assert.equal(code, 1008);
    assert.equal(await channelCount(), beforeCount, "rejected overlay connection grew the channels map");

    const res = await push(channel, { lat: 5, lng: 6 });
    assert.equal(res.status, 200);
    assert.equal(await channelCount(), beforeCount + 1, "push after the rejected overlay connection should be what first persists the channel");
  });

  test("overlay WS reconnecting after a channel's first push joins the real, broadcasting channel", async () => {
    const channel = "peek-existing-channel";
    await zeroDelay(channel);
    await push(channel, { lat: 30, lng: 40 });
    await new Promise((r) => setTimeout(r, 100));

    const late = await openOverlay(server.baseWs, channel);
    await waitFor(() => late.messages.some((m) => m.lat === 30 && m.lng === 40));

    const res = await push(channel, { lat: 31, lng: 41 });
    assert.equal(res.status, 200);
    await waitFor(() => late.messages.some((m) => m.lat === 31 && m.lng === 41));

    late.ws.close();
  });

  test("/health is channel-scoped: a token only validates for its own channel", async () => {
    const token = tokenFor("health-channel");
    const ok = await fetch(`${server.baseHttp}/health?channel=health-channel&token=${encodeURIComponent(token)}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");

    const wrongChannel = await fetch(`${server.baseHttp}/health?channel=other-channel&token=${encodeURIComponent(token)}`);
    assert.equal(wrongChannel.status, 403);

    const noChannel = await fetch(`${server.baseHttp}/health?token=${encodeURIComponent(token)}`);
    assert.equal(noChannel.status, 403);
  });
});

describe("single-tenant mode (MULTI_TENANT unset) — unchanged behaviour", () => {
  let server;
  const TOKEN = "legacy-shared-token";

  before(async () => {
    server = await startServer({ RELAY_TOKEN: TOKEN });
    // Zero the shared default channel's delay once so the rest of this
    // suite's assertions aren't waiting on the real 4500ms production default.
    const res = await fetch(`${server.baseHttp}/push?token=${TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ delay: 0 }),
    });
    assert.equal(res.status, 200);
  });
  after(async () => { await server.stop(); });

  test("/health matches the original single-token contract", async () => {
    const ok = await fetch(`${server.baseHttp}/health?token=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");

    const bad = await fetch(`${server.baseHttp}/health?token=wrong`);
    assert.equal(bad.status, 403);
    assert.equal(await bad.text(), "bad token");
  });

  test("/push matches the original single-token contract", async () => {
    const ok = await fetch(`${server.baseHttp}/push?token=${TOKEN}`, {
      method: "POST",
      body: JSON.stringify({ lat: 1, lng: 2 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "ok");

    const bad = await fetch(`${server.baseHttp}/push?token=wrong`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 403);
    assert.equal(await bad.text(), "bad token");
  });

  test("an unexpected ?channel= on /push is ignored — still one global room", async () => {
    const overlayNoChannel = await openOverlay(server.baseWs);
    const overlayWithChannel = await openOverlay(server.baseWs, "someone-elses-channel-id");

    const res = await fetch(`${server.baseHttp}/push?token=${TOKEN}&channel=another-id-entirely`, {
      method: "POST",
      body: JSON.stringify({ lat: 5, lng: 6 }),
    });
    assert.equal(res.status, 200);

    await waitFor(() => overlayNoChannel.messages.some((m) => m.lat === 5));
    await waitFor(() => overlayWithChannel.messages.some((m) => m.lat === 5));

    overlayNoChannel.ws.close();
    overlayWithChannel.ws.close();
  });

  test("root status line matches the original single-tenant format", async () => {
    const res = await fetch(`${server.baseHttp}/`);
    const text = await res.text();
    assert.match(text, /^location relay up \(broadcast delay \d+ms, timer-sync\)$/);
  });

  test("WS overlay/sender roles behave exactly as before, with no channel required", async () => {
    const overlay = await openOverlay(server.baseWs);
    const sender = new WebSocket(`${server.baseWs}/?role=sender&token=${TOKEN}`);
    await waitForOpen(sender);
    sender.send(JSON.stringify({ lat: 7, lng: 8 }));
    await waitFor(() => overlay.messages.some((m) => m.lat === 7));
    sender.close();
    overlay.ws.close();
  });

  test("WS sender with a bad token is still rejected the original way", async () => {
    const ws = new WebSocket(`${server.baseWs}/?role=sender&token=wrong`);
    const { code } = await waitForClose(ws);
    assert.equal(code, 1008);
  });

  test("unknown WS role is still rejected the original way", async () => {
    const ws = new WebSocket(`${server.baseWs}/?role=bogus`);
    const { code } = await waitForClose(ws);
    assert.equal(code, 1008);
  });
});
