# Calendar MCP Server

MCP server for the Infomaniak Calendar API. Supports both the classic stdio
transport (for desktop MCP clients such as Claude Desktop) and the Streamable
HTTP transport at `/mcp` (for network or containerized deployments).

The server is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`
and `@modelcontextprotocol/node`), pinned to the exact beta version
`2.0.0-beta.5`. Beta status is intentional and contained by exact pinning and
the project's test gate.

## Tools

1. `calendar_list_calendars`
   - List all your available calendars
   - Returns: List of calendars (with `id` and `name`)

2. `calendar_list_events`
   - Search events in your calendar
   - Required inputs:
      - `from` (string): Start time (eg. `2025-05-28 12:00:00`)
      - `to` (string): End time (eg. `2025-05-28 13:00:00`)
   - Optional inputs:
      - `calendar_id` (string): Calendar identifier (defaults to primary calendar if omitted)
   - Returns: List of events

3. `calendar_create_event`
   - Create an event in your calendar
   - Required inputs:
      - `title` (string): The event title
      - `start` (string): The event starting date (eg. `2025-05-28 12:00:00`)
      - `end` (string): The event ending date (eg. `2025-05-28 13:00:00`)
   - Optional inputs:
      - `description` (string): Event description
      - `attendees` (string): JSON array of attendee emails
      - `calendar_id` (string): Calendar identifier (defaults to primary calendar if omitted)
   - Returns: The created event

## Setup

Create a calendar token linked to your user:

- Visit the [API Token page](https://manager.infomaniak.com/v3/ng/accounts/token/list)
- Choose the `workspace:calendar user_info` scopes

`CALENDAR_TOKEN` is required for both transports.

## Transport: stdio

The installed `mcp-server-calendar` npm binary is the stdio MCP server. It
keeps the existing executable/handshake behavior and remains compatible with
desktop MCP clients.

### Usage with Claude Desktop (stdio)

Add the following to your `claude_desktop_config.json`:

#### NPX

```json
{
  "mcpServers": {
    "calendar": {
      "command": "npx",
      "args": [
        "-y",
        "@infomaniak/mcp-server-calendar"
      ],
      "env": {
        "CALENDAR_TOKEN": "your-token"
      }
    }
  }
}
```

#### Docker (stdio)

```json
{
  "mcpServers": {
    "calendar": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "CALENDAR_TOKEN",
        "infomaniak/mcp-server-calendar",
        "node",
        "dist/index.js"
      ],
      "env": {
        "CALENDAR_TOKEN": "your-token"
      }
    }
  }
}
```

The container image is HTTP-first; explicitly running `dist/index.js`
preserves the old stdio workflow inside the image.

## Transport: Streamable HTTP

The HTTP entry point exposes a stateless MCP endpoint at `/mcp`. It does not
issue or require `Mcp-Session-Id`; every accepted MCP request runs against a
fresh server instance.

### Local HTTP

```bash
# Create a local .env from the template, fill in your token.
cp .env.example .env
$EDITOR .env

# Start the HTTP entry point. --env-file is required; the app does not
# auto-load .env on its own.
node --env-file=.env dist/http.js
```

The default endpoint is `http://127.0.0.1:4500/mcp`. `MCP_HTTP_HOST` defaults
to `127.0.0.1` and `MCP_HTTP_PORT` defaults to `4500` outside the container.
Invalid ports, empty bind addresses, or empty allowlists are rejected before
listening.

### Docker (HTTP, recommended)

The image runs `dist/http.js` by default, binds to `0.0.0.0:4500` inside the
container, and runs as the unprivileged `node` user. `CALENDAR_TOKEN` is read
at runtime only — it is never baked into the image.

#### Same-host authenticated TLS reverse proxy (recommended)

```bash
docker build -t calendar-mcp:local .
docker run -d --rm --name calendar-mcp \
  -p 127.0.0.1:4500:4500 \
  --env-file .env \
  calendar-mcp:local
```

- `-p 127.0.0.1:4500:4500` publishes only on loopback so an authenticated
  reverse proxy on the same host is the only consumer.
- `MCP_HTTP_ALLOWED_HOSTS` and `MCP_HTTP_ALLOWED_ORIGINS` must include the
  proxy's `Host` and `Origin` values exactly as Node sees them. If your proxy
  rewrites `Host`, set the rewritten value. If it forwards the original
  `Host`, set the original value.
- The reverse proxy must authenticate clients (or the host must enforce an
  equivalent private-network/firewall boundary) and terminate TLS for any
  traffic that leaves the trusted host.

#### Trusted private-network (LAN) deployment

If you intentionally publish on a non-loopback host interface, you MUST
enforce an equivalent private-network/firewall boundary AND set
`MCP_HTTP_HOST=0.0.0.0` and explicit `MCP_HTTP_ALLOWED_HOSTS` for the LAN
hostnames you intend to serve. Host/Origin validation is a DNS-rebinding and
browser-origin defense — it is NOT authentication.

```bash
docker build -t calendar-mcp:local .
docker run -d --rm --name calendar-mcp \
  --network trusted_lan \
  --env-file .env \
  calendar-mcp:local
```

### Environment variables

| Variable | Required | Local default | Container default | Purpose |
|---|---|---|---|---|
| `CALENDAR_TOKEN` | yes | — | — (runtime only) | Infomaniak API credential |
| `MCP_HTTP_HOST` | no | `127.0.0.1` | `0.0.0.0` | Listener address |
| `MCP_HTTP_PORT` | no | `4500` | `4500` | Listener port (1..65535) |
| `MCP_HTTP_ALLOWED_HOSTS` | no | loopback hostnames | loopback hostnames | Comma-separated Host header values accepted by Node |
| `MCP_HTTP_ALLOWED_ORIGINS` | no | loopback origins | loopback origins | Comma-separated Origin values accepted when an Origin is present |

`.env.example` is documentation; both `node` and `docker` must be invoked
with their explicit `--env-file` option. Application code does not auto-load
environment files.

### HTTP security notes

- **Host and Origin checks are DNS-rebinding and browser-origin defenses,
  not authentication.** Any deployment reachable beyond loopback must use
  an authenticated reverse proxy or enforce a private-network/firewall
  boundary.
- The request body is bounded to 1 MiB and Node is configured with tight
  header/request/keep-alive/idle timeouts. The handler shuts down
  idempotently with a 10-second drain deadline.
- The HTTP entry point logs lifecycle messages to stderr only; stdout is
  reserved for the stdio transport.

## Rollback

The HTTP migration is intentionally contained:

- The npm binary (`mcp-server-calendar`) and `dist/index.js` still serve stdio.
- The container image can be pinned to a previous tag to roll back the HTTP
  default; clients that need stdio can run `node dist/index.js` directly
  inside the image.
- A beta version upgrade is a separate, tested dependency change. Do not
  bump `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, or the
  `@modelcontextprotocol/codemod` from `2.0.0-beta.5` without re-running the
  full test gate.

## Build

Docker build:

```bash
docker build -t calendar-mcp:local -f Dockerfile .
```

NPM:

```bash
npm install
npm run build
npm test
```

## Troubleshooting

If you encounter permission errors, verify that:

1. All required scopes are added to your calendar token
2. The token is correctly copied to your configuration
3. The MCP client is sending `Host` / `Origin` values that appear in the
   configured `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_ALLOWED_ORIGINS` allowlists
4. The container is publishing `4500` to an interface the client can reach
   (loopback or trusted-LAN), and an authenticated proxy or firewall is in
   place for any non-loopback path

## License

This MCP server is licensed under the MIT License.