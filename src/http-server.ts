import http from "node:http";
import crypto from "node:crypto";
import type {Socket} from "node:net";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";

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
    /**
     * Optional static bearer token. When set, every request to /mcp must
     * present `Authorization: Bearer <token>` or it is answered 401 before
     * any body parsing or MCP handler runs. When undefined, no bearer
     * authentication is performed (loopback dev default).
     */
    bearerToken?: string;
};

export type HttpServiceHandle = {
    address: () => { host: string; port: number } | null;
    shutdown: (signal?: NodeJS.Signals) => Promise<{exitCode: number}>;
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
// Origin / Host matching
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` matches the wildcard pattern `pattern`.
 * The only wildcard supported is a trailing `*` (e.g. `http://127.0.0.1:*`),
 * which matches any suffix of the value.
 */
function wildcardMatch(pattern: string, value: string): boolean {
    if (pattern === value) return true;
    if (!pattern.endsWith("*")) return false;
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
}

function hostMatches(allowed: string[], host: string): boolean {
    // Strip any port suffix for matching — allowedHosts is hostname-only.
    const bare = host.split(":")[0];
    for (const a of allowed) {
        if (a === host || a === bare) return true;
    }
    return false;
}

function originMatches(allowed: string[], origin: string): boolean {
    for (const a of allowed) {
        if (wildcardMatch(a, origin)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// JSON error response helper
// ---------------------------------------------------------------------------

function sendJsonError(
    res: http.ServerResponse,
    status: number,
    message: string,
    extraHeaders: Record<string, string> = {},
): void {
    if (res.headersSent) {
        try {
            res.end();
        } catch {
            /* ignore */
        }
        return;
    }
    const body = JSON.stringify({error: message});
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
}

// ---------------------------------------------------------------------------
// Bearer token authentication
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of two secret strings. Both sides are hashed with
 * SHA-256 first so `timingSafeEqual` always receives two 32-byte buffers —
 * this avoids both the length-mismatch fast path and any length leak of the
 * expected token.
 */
function secretEquals(presented: string, expected: string): boolean {
    const presentedHash = crypto.createHash("sha256").update(presented, "utf8").digest();
    const expectedHash = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Returns true only for an Authorization header of exactly the form
 * `Bearer <token>`: the scheme is matched case-insensitively, there must be
 * exactly one space between scheme and token, and the token value is compared
 * verbatim — no whitespace trimming. Anything else (missing header, wrong
 * scheme, tab, multiple spaces, empty token) is rejected.
 */
function isValidBearerToken(authHeader: string | undefined, expected: string): boolean {
    if (authHeader === undefined) return false;
    if (!/^Bearer /i.test(authHeader)) return false;
    const presented = authHeader.slice("Bearer ".length);
    // "Bearer " + empty, or "Bearer  …" (more than one space): reject without
    // trimming, so the extra whitespace can never be laundered into a match.
    if (presented.length === 0 || presented.startsWith(" ")) return false;
    return secretEquals(presented, expected);
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
        bearerToken,
    } = opts;

    // --- In-flight handler tracking ---
    const inflight = new Set<Promise<void>>();

    // --- Shutdown state ---
    let shutdownPromise: Promise<{exitCode: number}> | null = null;

    // --- Factory call counter (for tests) ---
    let factoryCallCount = 0;

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
            const rawUrl = req.url ?? "/";
            let url: URL;
            try {
                url = new URL(rawUrl, `http://${req.headers.host ?? "localhost"}`);
            } catch {
                sendJsonError(res, 400, "bad request");
                return;
            }
            if (url.pathname !== "/mcp") {
                sendJsonError(res, 404, "not found");
                return;
            }

            // 2. Bearer authentication — enforced before any body parsing or
            // MCP handler runs. Missing and invalid tokens get the identical
            // 401 response (no distinction). Host/Origin allowlists below
            // remain enforced independently for authenticated requests.
            if (
                bearerToken !== undefined &&
                !isValidBearerToken(req.headers.authorization, bearerToken)
            ) {
                sendJsonError(res, 401, "unauthorized", {"WWW-Authenticate": "Bearer"});
                return;
            }

            // 3. Host validation
            const hostHeader = req.headers.host;
            if (!hostHeader || !hostMatches(allowedHosts, hostHeader)) {
                sendJsonError(res, 403, "host not allowed");
                return;
            }

            // 4. Origin validation — only enforced when an Origin header is set
            const origin = req.headers.origin;
            if (origin !== undefined && !originMatches(allowedOrigins, origin)) {
                sendJsonError(res, 403, "origin not allowed");
                return;
            }

            // 5. Route based on method
            if (req.method === "GET" || req.method === "DELETE") {
                // No body; hand the request to the transport.
                const p = handleWithTransport(
                    req,
                    res,
                    undefined,
                    serverFactory,
                    token,
                    () => factoryCallCount++,
                ).catch((err) => {
                    if (res.headersSent) {
                        try {
                            res.end();
                        } catch {
                            /* ignore */
                        }
                        return;
                    }
                    console.error("unexpected request error:", err);
                    sendJsonError(res, 500, "internal server error");
                });
                inflight.add(p);
                p.finally(() => inflight.delete(p));
                return;
            }

            if (req.method !== "POST") {
                sendJsonError(res, 405, "method not allowed");
                return;
            }

            // POST: read bounded body, then hand parsed value
            const p = (async () => {
                try {
                    const parsedBody = await readBoundedJson(req, res, maxBodyBytes);
                    if (parsedBody === undefined) return;
                    await handleWithTransport(
                        req,
                        res,
                        parsedBody,
                        serverFactory,
                        token,
                        () => factoryCallCount++,
                    );
                } catch (err) {
                    if (err instanceof BodyReadError) {
                        // Response already sent by readBoundedJson; nothing more to do.
                        return;
                    }
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
                return {host: addr.address, port: addr.port};
            }
            return null;
        },

        shutdown: (signal?: NodeJS.Signals) => {
            if (shutdownPromise) return shutdownPromise;

            shutdownPromise = (async () => {
                try {
                    // Start server close (stops accepting new connections)
                    const serverCloseDone = new Promise<void>((resolve) => {
                        httpServer.close(() => resolve());
                    });

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

                    console.error(
                        `bound http shutdown complete${signal ? ` (signal=${signal})` : ""}`,
                    );
                    return {exitCode: 0};
                } catch (err) {
                    console.error("shutdown error:", err);
                    return {exitCode: 1};
                }
            })();

            return shutdownPromise;
        },

        factoryCalls: () => factoryCallCount,

        inflightHandlers: () => inflight.size,
    };

    return handle;
}

// ---------------------------------------------------------------------------
// Transport adapter
// ---------------------------------------------------------------------------

/**
 * Builds a fresh `McpServer` via the factory, connects it to a stateless
 * `StreamableHTTPServerTransport`, and lets the SDK convert the Node HTTP
 * request/response into the MCP Streamable HTTP protocol.
 *
 * Stateless (per-request) is the default: `sessionIdGenerator: undefined`
 * means the transport issues no `Mcp-Session-Id`, validates no session
 * header, and accepts a single request/response per transport instance.
 */
async function handleWithTransport(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsedBody: unknown,
    serverFactory: (token: string) => McpServer,
    token: string,
    onFactoryCall: () => void,
): Promise<void> {
    onFactoryCall();
    const server = serverFactory(token);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    } finally {
        // Best-effort cleanup; the transport may already be closed.
        try {
            await transport.close();
        } catch {
            /* ignore */
        }
    }
}
