// tools/spawn-relay.mjs — shared test helper: spawns a real server.js child
// process on a random port and waits for it to come up. Not itself a test
// file (doesn't match the `*.test.mjs` glob `npm test` runs), used by
// relay-server.test.mjs and relay-entitlement.test.mjs so both can run
// integration tests against an actual spawned instance rather than a mock.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "server.js");

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not become ready in time");
}

export async function startServer(envOverrides) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = randomPort();
    let stderr = "";
    const proc = spawn(process.execPath, [SERVER_PATH], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(port), MULTI_TENANT: "", RELAY_JWT_SECRET: "", ...envOverrides },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr.on("data", (c) => { stderr += c; });
    let exited = false;
    proc.once("exit", () => { exited = true; });
    try {
      await waitForReady(port, 3000);
      if (exited) throw new Error("server exited before becoming ready: " + stderr);
      return {
        port,
        baseHttp: `http://127.0.0.1:${port}`,
        baseWs: `ws://127.0.0.1:${port}`,
        stop() {
          return new Promise((resolve) => {
            if (exited) return resolve();
            proc.once("exit", resolve);
            proc.kill("SIGTERM");
          });
        },
      };
    } catch (e) {
      lastErr = e;
      if (!exited) proc.kill("SIGTERM");
    }
  }
  throw lastErr;
}
