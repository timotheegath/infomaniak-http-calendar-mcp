import http from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  hostHeaderValidation,
  originValidation,
} from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Socket } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpServiceOptions = {
  token: string;
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  serverFactory: (token: string) => McpServer;
  maxBodyBytes?: number;
  shutdownTimeoutMs?: number;
  headerTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  idleSocketTimeoutMs?: number;
  maxHeaderSize?: number;
};

export type HttpServiceHandle = {
  address: () => { host: string; port: number } | null;
  shutdown: (signal?: NodeJS.Signals) => Promise<{ exitCode: number }>;
  /** for tests: number of times serverFactory has been invoked since start */
  factoryCalls: () => number;
  /** for tests: number of currently-tracked accepted handler promises */
  inflightHandlers: () => number;
};

// ---------------------------------------------------------------------------
// Sentinel error for body-read failures (prevents SDK adapter invocation)
// ---------------------------------------------------------------------------

class BodyReadError extends Error {
  override name = "BodyReadError";
}

// ---------------------------------------------------------------------------
// Bounded JSON body reader
// ---------------------------------------------------------------------------

/**
 * Reads and validates a JSON request body with a size limit.
 *
 * On success resolves with the parsed JSON value.
 * On failure sends an error response directly and rejects with a `BodyReadError`
 * sentinel so the caller does not invoke the SDK adapter.
 */
function readBoundedJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let aborted = false;

    const abort = (status: number, message: string) => {
      if (aborted) return;
      aborted = true;
      sendJsonError(res, status, message);
      req.destroy();
      reject(new BodyReadError(message));
    };

    // --- Content-Type check ---
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (
      contentType !== "application/json" &&
      !contentType.startsWith("application/json;")
    ) {
      abort(415, "unsupported content type");
      return;
    }

    // --- Content-Length pre-check ---
    const cl = req.headers["content-length"];
    if (cl !== undefined) {
      const contentLength = Number(cl);
      if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
        abort(413, "payload too large");
        return;
      }
    }

    // --- Stream body ---
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        abort(413, "payload too large");
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const buffer = Buffer.concat(chunks);
      try {
        const parsed = JSON.parse(buffer.toString("utf-8"));
        resolve(parsed);
      } catch {
        abort(400, "invalid json");
      }
    });

    req.on("error", () => {
      if (!aborted) {
        aborted = true;
        reject(new BodyReadError("request stream error"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// JSON error response helper
// ---------------------------------------------------------------------------

function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// startHttpService
// ---------------------------------------------------------------------------

export async function startHttpService(
  opts: HttpServiceOptions,
): Promise<HttpServiceHandle> {
  const {
    token,
    host,
    port,
    allowedHosts,
    allowedOrigins,
    serverFactory,
    maxBodyBytes = 1024 * 1024,
    shutdownTimeoutMs = 10_000,
    headerTimeoutMs = 10_000,
    requestTimeoutMs = 30_000,
    keepAliveTimeoutMs = 5_000,
    idleSocketTimeoutMs = 60_000,
    maxHeaderSize = 16 * 1024,
  } = opts;

  // --- Build the SDK adapter chain once ---
  let factoryCallCount = 0;
  const mcpHandler = createMcpHandler(() => {
    factoryCallCount++;
    return serverFactory(token);
  });
  const nodeHandler = toNodeHandler(mcpHandler);

  // --- Pre-built validation middleware ---
  const checkHost = hostHeaderValidation(allowedHosts);
  const checkOrigin = originValidation(allowedOrigins);

  // --- In-flight handler tracking ---
  const inflight = new Set<Promise<void>>();

  // --- Shutdown state ---
  let shutdownPromise: Promise<{ exitCode: number }> | null = null;
  let stopping = false;

  // --- Create HTTP server ---
  const httpServer = http.createServer(
    {
      maxHeaderSize,
      headersTimeout: headerTimeoutMs,
      requestTimeout: requestTimeoutMs,
      keepAliveTimeout: keepAliveTimeoutMs,
    },
    (req, res) => {
      // 1. Parse URL — only /mcp is valid
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/mcp") {
        sendJsonError(res, 404, "not found");
        return;
      }

      // 2. Host / Origin validation (before body read, before factory)
      if (!checkHost(req, res)) return;
      if (!checkOrigin(req, res)) return;

      // 3. Route based on method
      if (req.method !== "POST") {
        // Non-POST: no body, hand undefined to the Node handler
        const p = (async () => {
          try {
            await nodeHandler(req, res, undefined);
          } catch {
            // Handler errors are surfaced by the SDK via the response;
            // we just need the promise to settle.
          }
        })();
        inflight.add(p);
        p.finally(() => inflight.delete(p));
        return;
      }

      // POST: read bounded body, then hand parsed value
      const p = (async () => {
        try {
          const parsedBody = await readBoundedJson(req, res, maxBodyBytes);
          await nodeHandler(req, res, parsedBody);
        } catch (err) {
          if (err instanceof BodyReadError) {
            // Response already sent by readBoundedJson; nothing more to do.
            return;
          }
          // Unexpected error — log and try to send a fallback.
          console.error("unexpected request error:", err);
          if (!res.headersSent) {
            sendJsonError(res, 500, "internal server error");
          }
        }
      })();
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    },
  );

  httpServer.timeout = idleSocketTimeoutMs;

  // --- Listen ---
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  // --- Handle ---
  const handle: HttpServiceHandle = {
    address: () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object" && "port" in addr) {
        return { host: addr.address, port: addr.port };
      }
      return null;
    },

    shutdown: (signal?: NodeJS.Signals) => {
      if (shutdownPromise) return shutdownPromise;

      shutdownPromise = (async () => {
        try {
          stopping = true;

          // Start server close (stops accepting new connections)
          const serverCloseDone = new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
          });

          // Close MCP handler exactly once
          await mcpHandler.close();

          // Wait for server close + in-flight handlers with timeout
          const deadline = Date.now() + shutdownTimeoutMs;

          const waitFor: Promise<unknown>[] = [serverCloseDone];
          if (inflight.size > 0) {
            waitFor.push(Promise.allSettled([...inflight]));
          }

          const timeout = new Promise<void>((resolve) => {
            const remaining = deadline - Date.now();
            if (remaining > 0) {
              setTimeout(resolve, remaining);
            } else {
              resolve();
            }
          });

          await Promise.race([Promise.all(waitFor), timeout]);

          // Force-close remaining connections after deadline
          if (typeof httpServer.closeAllConnections === "function") {
            httpServer.closeAllConnections();
          } else {
            // Fallback for older Node (deprecated but present on Node 22)
            const conns = (httpServer as unknown as Record<string, unknown>)
              .connections as Set<Socket> | undefined;
            if (conns) {
              for (const socket of conns) {
                socket.destroy();
              }
            }
          }

          // Second close after force-destroy (callback fires immediately if already closed)
          await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
          });

          console.error("bound http shutdown complete");
          return { exitCode: 0 };
        } catch (err) {
          console.error("shutdown error:", err);
          return { exitCode: 1 };
        }
      })();

      return shutdownPromise;
    },

    factoryCalls: () => factoryCallCount,

    inflightHandlers: () => inflight.size,
  };

  return handle;
}