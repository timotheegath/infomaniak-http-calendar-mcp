import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { startHttpService } from "../dist/http-server.js";
import { createCalendarMcpServer } from "../dist/mcp-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSse(body) {
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

function mcpPost(port, jsonBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Host: `127.0.0.1:${port}`,
        },
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
    req.write(JSON.stringify(jsonBody));
    req.end();
  });
}

async function startTestService() {
  const handle = await startHttpService({
    token: "mock-token",
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["http://127.0.0.1:*"],
    serverFactory: (t) => createCalendarMcpServer(t),
    shutdownTimeoutMs: 800,
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP tool execution with mocked fetch", () => {
  let originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("calendar_list_calendars returns stubbed data over HTTP", async () => {
    const stubbedData = { data: { calendars: [{ id: 1, name: "Test Cal" }] } };
    let capturedAuth = null;

    globalThis.fetch = async (url, options) => {
      capturedAuth = options?.headers?.Authorization;
      return {
        ok: true,
        json: async () => stubbedData,
      };
    };

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

      // Call the tool
      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "calendar_list_calendars", arguments: {} },
      });
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);
      assert.ok(parsed?.result?.content, "should have content");

      const textContent = parsed.result.content.find(
        (c) => c.type === "text",
      );
      assert.ok(textContent, "should have text content");
      const resultData = JSON.parse(textContent.text);
      assert.deepStrictEqual(resultData, stubbedData.data.calendars);

      // Verify the token was sent as Bearer
      assert.ok(capturedAuth, "Authorization header should be present");
      assert.ok(
        capturedAuth.startsWith("Bearer mock-token"),
        `Authorization should start with Bearer mock-token, got "${capturedAuth}"`,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await handle.shutdown();
    }
  });

  it("calendar_list_events returns stubbed data over HTTP", async () => {
    const stubbedEvents = {
      data: [{ id: 10, title: "Event 1", start: "2025-01-01 10:00:00" }],
    };

    globalThis.fetch = async (url, options) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      // Return calendars for getDefaultCalendar
      if (urlStr.includes("/calendar/pim/calendar")) {
        return {
          ok: true,
          json: async () => ({
            result: "success",
            data: { calendars: [{ id: "1", name: "Default" }] },
          }),
        };
      }
      // Return events for listEvents
      return {
        ok: true,
        json: async () => stubbedEvents,
      };
    };

    const handle = await startTestService();
    const port = handle.address().port;
    try {
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

      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "calendar_list_events",
          arguments: {
            from: "2025-01-01 00:00:00",
            to: "2025-01-02 00:00:00",
          },
        },
      });
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);
      assert.ok(parsed?.result?.content);

      const textContent = parsed.result.content.find((c) => c.type === "text");
      assert.ok(textContent);
      const resultData = JSON.parse(textContent.text);
      assert.deepStrictEqual(resultData, stubbedEvents.data);
    } finally {
      globalThis.fetch = originalFetch;
      await handle.shutdown();
    }
  });

  it("calendar_create_event returns stubbed data over HTTP", async () => {
    const stubbedData = { data: { id: 42 } };

    globalThis.fetch = async (url, options) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = options?.method ?? "GET";

      // Return profile data for getUserProfile
      if (urlStr.includes("/profile")) {
        return {
          ok: true,
          json: async () => ({
            result: "success",
            data: {
              email: "test@example.com",
              display_name: "Test User",
              preferences: { timezone: { name: "Europe/Zurich" } },
            },
          }),
        };
      }
      // Return calendars for getDefaultCalendar (GET)
      if (method === "GET" && urlStr.includes("/calendar")) {
        return {
          ok: true,
          json: async () => ({
            result: "success",
            data: { calendars: [{ id: "1", name: "Default" }] },
          }),
        };
      }
      // Return created event for POST
      return {
        ok: true,
        json: async () => stubbedData,
      };
    };

    const handle = await startTestService();
    const port = handle.address().port;
    try {
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

      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "calendar_create_event",
          arguments: {
            title: "Test Event",
            start: "2025-01-01 10:00:00",
            end: "2025-01-01 11:00:00",
            description: "A test event",
          },
        },
      });
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);
      assert.ok(parsed?.result?.content);

      const textContent = parsed.result.content.find((c) => c.type === "text");
      assert.ok(textContent);
      const resultData = JSON.parse(textContent.text);
      assert.deepStrictEqual(resultData, stubbedData.data);
    } finally {
      globalThis.fetch = originalFetch;
      await handle.shutdown();
    }
  });

  it("calendar_create_event propagates invalid attendees error", async () => {
    globalThis.fetch = async (url, options) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      const method = options?.method ?? "GET";

      if (urlStr.includes("/profile")) {
        return {
          ok: true,
          json: async () => ({
            result: "success",
            data: {
              email: "test@example.com",
              display_name: "Test User",
              preferences: { timezone: { name: "Europe/Zurich" } },
            },
          }),
        };
      }
      if (method === "GET" && urlStr.includes("/calendar")) {
        return {
          ok: true,
          json: async () => ({
            result: "success",
            data: { calendars: [{ id: "1", name: "Default" }] },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { id: 1 } }) };
    };

    const handle = await startTestService();
    const port = handle.address().port;
    try {
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

      const resp = await mcpPost(port, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "calendar_create_event",
          arguments: {
            title: "Test",
            start: "2025-01-01 10:00:00",
            end: "2025-01-01 11:00:00",
            attendees: "not-valid-json",
          },
        },
      });
      assert.strictEqual(resp.status, 200);
      const parsed = parseSse(resp.body);

      // The error should be in the JSON-RPC response (isError or error field)
      if (parsed.error) {
        assert.ok(
          parsed.error.message.includes("Invalid attendees"),
          `error message should mention attendees, got: ${parsed.error.message}`,
        );
      } else if (parsed.result?.isError) {
        const textContent = parsed.result.content?.find((c) => c.type === "text");
        assert.ok(textContent, "should have text content in error");
        assert.ok(
          textContent.text.includes("Invalid attendees"),
          `error text should mention attendees, got: ${textContent.text}`,
        );
      } else {
        assert.fail(
          `expected error response, got: ${JSON.stringify(parsed)}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      await handle.shutdown();
    }
  });
});