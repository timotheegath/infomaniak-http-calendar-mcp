// Manual smoke test for the dist/http.js binary.
// Usage: node tests/manual-http-smoke.mjs
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 14501;
const TOKEN = "manual-smoke-token";

const child = spawn(
  "node",
  ["dist/http.js"],
  {
    env: {
      ...process.env,
      CALENDAR_TOKEN: TOKEN,
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let errBuf = "";
child.stderr.on("data", (d) => (errBuf += d));

function rawSend(method, path, data, extra = {}) {
  return new Promise((resolve) => {
    const body = data || "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: { ...extra, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: buf }),
        );
      },
    );
    req.on("error", (e) => resolve({ status: -1, error: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}

const sendJson = (method, path, body) =>
  rawSend(method, path, JSON.stringify(body), {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Host: "127.0.0.1:" + PORT,
  });

const headersWithAccept = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

function parseSse(body) {
  // SSE framing: lines of `data: <json>\n\n`. Take the last data line.
  for (const line of body.split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }
    }
  }
  return null;
}

function bail(reason) {
  console.log("FAIL:", reason);
  console.log("stderr:", errBuf);
  child.kill("SIGTERM");
  process.exit(1);
}

async function main() {
  for (let i = 0; i < 80 && !errBuf.includes("listening on"); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!errBuf.includes("listening on")) bail("server did not announce listening");
  console.log("OK   bound http://127.0.0.1:" + PORT + "/mcp");

  const init = await sendJson("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  if (init.status !== 200) bail("initialize status " + init.status);
  if ("mcp-session-id" in init.headers) bail("Mcp-Session-Id was set");
  const initJson = parseSse(init.body);
  if (!initJson?.result?.serverInfo) bail("initialize response missing serverInfo");
  console.log("OK   POST /mcp initialize -> 200 (no Mcp-Session-Id)");

  const list = await sendJson("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listJson = parseSse(list.body);
  const names = (listJson?.result?.tools || []).map((t) => t.name).join(",");
  if (names !== "calendar_list_calendars,calendar_list_events,calendar_create_event") {
    bail("tools/list names mismatch: " + names);
  }
  console.log("OK   tools/list -> " + names);

  const bad = await rawSend("GET", "/not-mcp", "");
  if (bad.status !== 404) bail("/not-mcp status " + bad.status);
  console.log("OK   GET /not-mcp -> 404");

  const queryOk = await sendJson("POST", "/mcp?foo=bar", {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });
  if (queryOk.status !== 200) bail("/mcp?foo=bar status " + queryOk.status);
  console.log("OK   POST /mcp?foo=bar -> 200 (query parameters accepted)");

  const hostBad = await rawSend(
    "POST",
    "/mcp",
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }),
    { Host: "evil.example.com", "Content-Type": "application/json" },
  );
  if (hostBad.status < 400 || hostBad.status >= 500) bail("untrusted Host accepted: " + hostBad.status);
  console.log("OK   untrusted Host -> " + hostBad.status);

  child.kill("SIGTERM");
  const exit = await new Promise((r) => child.on("exit", r));
  if (exit !== 0) bail("exit code on SIGTERM was " + exit);
  console.log("OK   SIGTERM -> exit 0");

  console.log("\nALL OK");
  process.exit(0);
}

main().catch((e) => bail("smoke error: " + (e?.stack || e)));
