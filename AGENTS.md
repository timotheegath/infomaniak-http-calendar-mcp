# AGENTS.md

Infomaniak Calendar MCP server. Single TypeScript package, ESM, Node 22.

## Commands

- `npm run build` — `tsc` + `shx chmod +x dist/*.js` → `dist/`.
- `npm test` — builds, then `node --test tests/*.mjs`. Tests import from `dist/`, so the build must run first; `npm test` handles the ordering.
- `npm run watch` — `tsc --watch` for iterative development.

There is **no lint, formatter, or separate typecheck script**. `npm test` is the verification gate.

## Architecture

- `src/mcp-server.ts` — **shared** `createCalendarMcpServer(token)` factory. Reads `package.json` version, constructs a fresh `CalendarClient`, and registers all three calendar tools on a new `McpServer` via `registerTool()` with `zod/v4` `z.object(...)` schemas. Each call returns a brand-new server so the same factory can serve both the long-lived stdio transport and the per-request stateless HTTP transport without sharing state.
- `src/index.ts` — shebang-bearing **stdio** executable. Validates `CALENDAR_TOKEN`, calls `createCalendarMcpServer(token)`, and connects it to `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. Stdout is protocol-only; lifecycle messages go to stderr.
- `src/http.ts` — shebang-bearing **HTTP** executable. Validates configuration via `resolveHttpConfig()`, wires the factory into `startHttpService()`, installs `SIGINT`/`SIGTERM` handlers, and exits through the same shutdown promise. The default endpoint is `http://127.0.0.1:4500/mcp`.
- `src/http-config.ts` — `resolveHttpConfig(env?)` validates `CALENDAR_TOKEN`, `MCP_HTTP_HOST` (default `127.0.0.1`), `MCP_HTTP_PORT` (default `4500`), `MCP_HTTP_ALLOWED_HOSTS`, and `MCP_HTTP_ALLOWED_ORIGINS`. Rejects invalid ports, empty bind addresses, and unusable allowlists before listening.
- `src/http-server.ts` — testable `startHttpService(opts)` that builds the SDK adapter once with `createMcpHandler(() => serverFactory(token))` + `toNodeHandler(...)`. Routes `/mcp` only (404 elsewhere), runs `hostHeaderValidation` and `originValidation` before body reads, applies a bounded 1 MiB JSON body reader, configures 16 KiB max header size + 10/30/5/60-second timeouts, and provides one idempotent shutdown promise with a 10-second drain deadline and force-close fallback.
- `src/calendar-client.ts` — thin `fetch` client against `https://api.infomaniak.com`. Methods: `getCalendars`, `getDefaultCalendar`, `getUserProfile`, `listEvents`, `createEvent`. `parseDate` formats ISO → `YYYY-MM-DD HH:MM:SS`. Transport-independent.
- `tests/verify.mjs` — unit tests for `CalendarClient`; stubs `globalThis.fetch`.
- `tests/server-startup.test.mjs` — spawns `dist/index.js` **through a bin symlink** and drives an MCP `initialize` handshake over stdio. Specifically catches bin-executable regressions.
- `tests/http-server.test.mjs` — raw `node:http` tests for the HTTP service (initialize, routing, `/mcp` query acceptance, factory counting, Host/Origin rejection, body bound, shutdown).

## Gotchas

- **Shebang + `chmod +x` are load-bearing.** `src/index.ts` and `src/http.ts` start with `#!/usr/bin/env node`, and the build script applies `shx chmod +x dist/*.js`. npm installs the package as a `bin` symlink; without +x the symlink target is non-executable and `npx mcp-server-calendar` fails silently. The startup test exists to catch exactly this — do not delete or weaken it. If you swap `tsc` for another compiler, preserve the chmod step.
- **`npm test` builds before testing.** Tests import from `dist/`. Running `node --test tests/*.mjs` directly without a prior build will fail.
- **Tests are `.mjs` using only `node:test`.** No jest/vitest. `fetch` is mocked by reassigning `globalThis.fetch`.
- **`attendees` is a JSON-encoded string of emails**, not a real array (per README and `calendar-client.ts`). Invalid JSON throws `Invalid attendees, JSON array of email address is expected`.
- **Inconsistent response shapes.** `calendar_list_calendars` returns `response.data.calendars`; `calendar_list_events` and `calendar_create_event` return `response.data`. Each is wrapped in `{content: [{type: "text", text: JSON.stringify(...)}]}`. If you change one tool, audit the others.
- **HTTP service uses one `McpServer` per accepted MCP request.** Reusing a single instance across HTTP requests leaks state. The factory is injected and counted in tests; never export a singleton or call `server.connect()` on a shared server in the HTTP path.
- **Host/Origin checks are DNS-rebinding and browser-origin defenses, not authentication.** The HTTP service rejects Host/Origin values outside `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_ALLOWED_ORIGINS` before reading the body. Any deployment beyond loopback MUST add an authenticated reverse proxy or private-network/firewall boundary; the operator must set `MCP_HTTP_ALLOWED_HOSTS` to the `Host` value the proxy forwards (or rewrites to).
- **HTTP lifecycle output goes to stderr only.** Stdout is reserved for the stdio transport; never write a log line to `console.log` from `src/http.ts` or `src/http-server.ts`.
- **Shutting down must be idempotent.** `HttpServiceHandle.shutdown()` returns the same promise on repeat calls and calls `mcpHandler.close()` exactly once. Tests assert duplicate signals do not produce double-close side effects.
- **Beta MCP packages are pinned exactly.** `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and the `@modelcontextprotocol/codemod` must all be at exactly `2.0.0-beta.5`. A beta upgrade is a separate, tested dependency change; do not bump one without bumping the others and re-running the full test gate.
- **`zod/v4` only.** Schema definitions import from `zod/v4`, not `zod`, to keep the codemod-applied schemas on the same Zod 4 surface the SDK v2 `registerTool()` API expects.
- **No dotenv dependency.** The application does not auto-load `.env`. Node and Docker must be invoked with their explicit `--env-file` option; `.env.example` is documentation only.
- **`.dockerignore` is the secret boundary.** Real `.env` files, `.git`, `node_modules`, `dist`, `tests`, `openspec`, and `.opencode` are excluded from the build context. The container does not embed `CALENDAR_TOKEN`. The Dockerfile installs production-only deps and runs as the unprivileged `node` user; port `4500` needs no elevated capability.
- **Docker container is HTTP-first.** The image entrypoint is `node dist/http.js`. Operators that need stdio inside the container must run `node dist/index.js` explicitly. The npm binary and `dist/index.js` remain available for stdio clients.
- **Semver releases are not direct `npm publish`.** `.releaserc.json` has `npmPublish: false`; publishing is done by `.github/workflows/npm.yml` on GitHub release publication. The release workflow needs a `RELEASE_TOKEN` PAT — the default `GITHUB_TOKEN` cannot trigger downstream workflows.
- **`Dockerfile` is multi-stage.** The builder stage installs deps (which runs `prepare` → build) and is the only stage that needs `src/` and `tsconfig.json`. The release stage copies only `dist/`, `package.json`, and `package-lock.json` from the builder; the `+x` bits applied by `shx chmod +x dist/*.js` are preserved across the `COPY --from=builder`.

## Environment

- `CALENDAR_TOKEN` — required at startup for both transports. Create at `https://manager.infomaniak.com/v3/ng/accounts/token/list` with `workspace:calendar user_info` scopes. The startup test passes `CALENDAR_TOKEN: "test-token"` to bypass the missing-token exit.
- `MCP_HTTP_HOST` (HTTP only, default `127.0.0.1`; container default `0.0.0.0`) — bind address.
- `MCP_HTTP_PORT` (HTTP only, default `4500`) — port. Must be an integer in `1..65535`; non-integer, decimal, exponent, whitespace, and `+`-prefixed values are rejected before listening.
- `MCP_HTTP_ALLOWED_HOSTS` (HTTP only, default `127.0.0.1,localhost,[::1]`) — comma-separated Host header values accepted by Node.
- `MCP_HTTP_ALLOWED_ORIGINS` (HTTP only, default `http://127.0.0.1:*,http://localhost:*,http://[::1]:*`) — comma-separated Origin values accepted when an Origin is present.
- Node 22 (per CI). `tsconfig.json` targets ES2022 with `Node16` module resolution; `strict: true`.

## CI

- `.github/workflows/test.yml` — `npm ci` + `npm test` on push/PR to `main`/`master`.
- `.github/workflows/release.yml` — semantic-release on `main`/`master`.
- `.github/workflows/npm.yml` — publishes to npm on GitHub release.
- `.github/workflows/docker.yml` — builds and pushes `ghcr.io/<repo>` on tags.
- Dependabot: weekly, 7-day cooldown, both npm and github-actions.