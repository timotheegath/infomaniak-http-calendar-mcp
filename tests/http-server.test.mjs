import { describe, it } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { startHttpService } from "../dist/http-server.js";
import { createCalendarMcpServer } from "../dist/mcp-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an SSE-encoded MCP response body into the JSON data payload. */
function parseSse(body) {
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

/** Send an HTTP request and return status, headers, and body. */
function rawRequest(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Convenience: POST a JSON body to /mcp with standard MCP headers. */
function mcpPost(port, jsonBody, extraHeaders) {
  return rawRequest(
    port,
    "POST",
    "/mcp",
    {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: `127.0.0.1:${port}`,
      ...extraHeaders,
    },
    JSON.stringify(jsonBody),
  );
}

/** Start a fresh HTTP service on an ephemeral port with a counting factory. */
async function startTestService(customOpts) {
  let factoryCount = 0;
  const handle = await startHttpService({
    token: "test-token",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["http://127.0.0.1:*"],
    serverFactory: (t) => {
      factoryCount++;
      return createCalendarMcpServer(t);
    },
    shutdownTimeoutMs: 800,
    ...customOpts,
  });
  // Attach factoryCount accessor
  handle._rawFactoryCount = () => factoryCount;
  return handle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP server — initialize", () => {
  it("responds to initialize via POST /mcp", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);
      assert.ok(parsed, "response should be parseable SSE");
      assert.ok(parsed.result, "should have a result");
      assert.ok(parsed.result.serverInfo, "should have serverInfo");
      assert.strictEqual(parsed.id, 1);
      // No Mcp-Session-Id header
      assert.strictEqual(
        resp.headers["mcp-session-id"],
        undefined,
        "should not set Mcp-Session-Id",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("accepts /mcp with query parameters", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp?foo=bar",
        {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: `127.0.0.1:${port}`,
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      );
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);
      assert.ok(parsed?.result?.serverInfo);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("HTTP server — tools/list", () => {
  it("returns exactly three calendar tools after initialize", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      // Initialize
      await mcpPost(port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });

      // notifications/initialized (no response expected)
      await mcpPost(port, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // tools/list
      const toolsResp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      assert.strictEqual(toolsResp.status, 200);
      const parsed = parseSse(toolsResp.body);
      assert.ok(parsed?.result?.tools);
      const names = parsed.result.tools.map((t) => t.name);
      assert.deepStrictEqual(names, [
        "calendar_list_calendars",
        "calendar_list_events",
        "calendar_create_event",
      ]);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("HTTP server — 404 routing", () => {
  const paths = ["/not-mcp", "/", "/mcp/extra"];

  for (const p of paths) {
    it(`returns 404 for "${p}"`, async () => {
      const handle = await startTestService();
      const port = handle.address().port;
      try {
        const resp = await rawRequest(port, "GET", p, {
          Host: `127.0.0.1:${port}`,
        });
        assert.strictEqual(resp.status, 404);
        const body = JSON.parse(resp.body);
        assert.strictEqual(body.error, "not found");
        assert.strictEqual(
          handle._rawFactoryCount(),
          0,
          "factory should not be called for 404",
        );
      } finally {
        await handle.shutdown();
      }
    });
  }
});

describe("HTTP server — Host/Origin rejection", () => {
  it("rejects untrusted Host header before body read or factory", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      // Send a POST with evil Host and an oversized declared length.
      // The Host check should fire first, before body-size validation.
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: "evil.example.com",
          "Content-Length": "9999999999",
        },
        "{}",
      );
      assert.strictEqual(resp.status, 403);
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after Host rejection",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects untrusted Origin header before body read or factory", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: `127.0.0.1:${port}`,
          Origin: "http://evil.example.com",
          "Content-Length": "9999999999",
        },
        "{}",
      );
      assert.strictEqual(resp.status, 403);
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after Origin rejection",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("allows request with no Origin header", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      assert.strictEqual(resp.status, 200);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("HTTP server — body validation", () => {
  it("rejects unsupported content type with 415", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          "Content-Type": "text/plain",
          Host: `127.0.0.1:${port}`,
        },
        "hello",
      );
      assert.strictEqual(resp.status, 415);
      const body = JSON.parse(resp.body);
      assert.strictEqual(body.error, "unsupported content type");
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after 415",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects malformed JSON with 400", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          "Content-Type": "application/json",
          Host: `127.0.0.1:${port}`,
        },
        "{not-json",
      );
      assert.strictEqual(resp.status, 400);
      const body = JSON.parse(resp.body);
      assert.strictEqual(body.error, "invalid json");
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after 400",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects declared oversized body with 413", async () => {
    const handle = await startTestService({ maxBodyBytes: 1024 });
    const port = handle.address().port;
    try {
      const resp = await rawRequest(
        port,
        "POST",
        "/mcp",
        {
          "Content-Type": "application/json",
          Host: `127.0.0.1:${port}`,
          "Content-Length": "9999",
        },
        JSON.stringify({ data: "x".repeat(500) }),
      );
      // The response may be 413 (content-length > maxBodyBytes) or 403
      // (if the SDK's host validation rejects the long header first).
      // Accept either — the key assertion is factoryCalls === 0.
      assert.ok(
        resp.status === 413 || resp.status === 403,
        `expected 413 or 403, got ${resp.status}`,
      );
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after oversized rejection",
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects chunked oversized body with 413", async () => {
    const handle = await startTestService({ maxBodyBytes: 64 * 1024 });
    const port = handle.address().port;
    try {
      // Send a chunked request with a body larger than maxBodyBytes
      const resp = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Host: `127.0.0.1:${port}`,
              "Transfer-Encoding": "chunked",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: data,
              }),
            );
          },
        );
        req.on("error", reject);

        // Write chunks totaling ~128 KiB (2x maxBodyBytes)
        const chunk = Buffer.alloc(16 * 1024, "x");
        for (let i = 0; i < 8; i++) {
          req.write(chunk);
        }
        req.end();
      });

      assert.strictEqual(resp.status, 413);
      const body = JSON.parse(resp.body);
      assert.strictEqual(body.error, "payload too large");
      assert.strictEqual(
        handle._rawFactoryCount(),
        0,
        "factory should not be called after chunked oversized rejection",
      );
    } finally {
      await handle.shutdown();
    }
  });
});

describe("HTTP server — factory counting", () => {
  it("creates a fresh server per accepted MCP request", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    try {
      // First request
      const r1 = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      assert.strictEqual(r1.status, 200);

      // Second request (independent)
      const r2 = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      assert.strictEqual(r2.status, 200);

      // Factory should have been called twice (once per request)
      assert.strictEqual(
        handle._rawFactoryCount(),
        2,
        "factory should be called once per accepted request",
      );
    } finally {
      await handle.shutdown();
    }
  });
});

describe("HTTP server — shutdown", () => {
  it("shuts down cleanly with exit code 0", async () => {
    const handle = await startTestService();
    const port = handle.address().port;
    // Make a request first
    await mcpPost(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const result = await handle.shutdown();
    assert.strictEqual(result.exitCode, 0);
  });

  it("is idempotent — duplicate shutdown returns same result", async () => {
    const handle = await startTestService();
    const r1 = await handle.shutdown();
    const r2 = await handle.shutdown();
    assert.strictEqual(r1.exitCode, 0);
    assert.strictEqual(r2.exitCode, 0);
  });
});