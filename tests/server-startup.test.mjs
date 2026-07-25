import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");

// Launches dist/index.js through a bin symlink, drives an MCP initialize
// handshake over stdio, and resolves with the first JSON-RPC response
// (or null on timeout). The caller can optionally provide a callback to
// send additional messages after initialize and before cleanup.
function stdioSession(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bin-"));
    const link = path.join(linkDir, "mcp-server-calendar");
    fs.symlinkSync(entry, link);

    const child = spawn(process.execPath, [link], {
      env: { ...process.env, CALENDAR_TOKEN: "test-token" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;
    const messages = [];

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      try {
        fs.rmSync(linkDir, { recursive: true, force: true });
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          messages.push(msg);
        } catch {}
      }
    });

    child.on("exit", () => finish(null));

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "startup-test", version: "1.0.0" },
      },
    };
    child.stdin.write(JSON.stringify(initialize) + "\n");

    // After a short delay, resolve with the session handle so the caller
    // can send more messages. We use a polling approach to collect messages.
    const collect = () => {
      if (settled) return;
      // Look for the initialize response (id === 1)
      const initResp = messages.find((m) => m.id === 1);
      if (initResp) {
        resolve({
          child,
          linkDir,
          messages,
          send: (msg) => {
            child.stdin.write(JSON.stringify(msg) + "\n");
          },
          waitForId: (id, ttl = 3000) => {
            return new Promise((resolveWait) => {
              const check = () => {
                const found = messages.find((m) => m.id === id);
                if (found) return resolveWait(found);
                if (settled) return resolveWait(null);
                setTimeout(check, 50);
              };
              setTimeout(() => resolveWait(null), ttl);
              check();
            });
          },
          finish: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            try {
              fs.rmSync(linkDir, { recursive: true, force: true });
            } catch {}
          },
        });
      } else {
        setTimeout(collect, 50);
      }
    };
    setTimeout(collect, 100);
  });
}

describe("server startup", () => {
  it("responds to an MCP initialize handshake when launched via bin symlink", async () => {
    const session = await stdioSession();
    assert.ok(
      session,
      "server exited without answering initialize — main() did not connect the transport (bin-symlink entry-point bug)",
    );

    const initResp = session.messages.find((m) => m.id === 1);
    assert.ok(initResp, "initialize response should be present");
    assert.strictEqual(initResp.id, 1);
    assert.ok(initResp.result, "initialize response should carry a result");
    assert.ok(
      initResp.result.serverInfo,
      "initialize result should include serverInfo",
    );
    assert.ok(
      typeof initResp.result.serverInfo.version === "string" &&
        initResp.result.serverInfo.version.length > 0,
      "serverInfo.version should be a non-empty string",
    );
    assert.ok(
      typeof initResp.result.protocolVersion === "string" &&
        initResp.result.protocolVersion.length > 0,
      "protocolVersion should be a non-empty string",
    );

    session.finish();
  });
});

describe("stdio tool list", () => {
  it("returns exactly three calendar tools via stdio", async () => {
    const session = await stdioSession();
    assert.ok(session, "stdio session should start");

    // Send notifications/initialized
    session.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Small delay to let the notification be processed
    await new Promise((r) => setTimeout(r, 100));

    // Send tools/list
    session.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    // Wait for the response
    const toolsResp = await session.waitForId(2, 5000);
    assert.ok(toolsResp, "tools/list response should be received");
    assert.ok(toolsResp.result, "tools/list should have a result");
    assert.ok(
      Array.isArray(toolsResp.result.tools),
      "tools should be an array",
    );

    const toolNames = toolsResp.result.tools.map((t) => t.name);
    assert.deepStrictEqual(toolNames, [
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_create_event",
    ]);

    session.finish();
  });
});