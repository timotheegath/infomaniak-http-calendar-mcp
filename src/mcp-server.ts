import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createRequire } from "node:module";
import { CalendarClient } from "./calendar-client.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const SERVER_NAME = "Infomaniak calendar MCP Server";

/**
 * Creates a fresh, fully-registered MCP server for the Infomaniak calendar API.
 *
 * Each invocation returns a new `McpServer` so the same factory can serve
 * both the long-lived stdio transport and the per-request stateless HTTP
 * transport without sharing state across exchanges.
 */
export function createCalendarMcpServer(token: string): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version,
    },
    {
      capabilities: {
        completions: {},
        prompts: {},
        resources: {},
        tools: {},
      },
    },
  );

  const calendarClient = new CalendarClient(token);

  server.registerTool(
    "calendar_list_calendars",
    {
      description: "List all available Infomaniak calendars",
      inputSchema: z.object({}),
    },
    async () => {
      const response = await calendarClient.getCalendars();
      return {
        content: [
          { type: "text", text: JSON.stringify(response.data.calendars) },
        ],
      };
    },
  );

  server.registerTool(
    "calendar_list_events",
    {
      description:
        "List Infomaniak calendar events within a specified time range",
      inputSchema: z.object({
        from: z.string().describe("Start time (Date time string)"),
        to: z.string().describe("End time (Date time string)"),
        calendar_id: z
          .string()
          .describe("Calendar ID (optional, uses default if not provided)")
          .optional(),
      }),
    },
    async ({ from, to, calendar_id }) => {
      const response = await calendarClient.listEvents(from, to, calendar_id);
      return {
        content: [{ type: "text", text: JSON.stringify(response.data) }],
      };
    },
  );

  server.registerTool(
    "calendar_create_event",
    {
      description: "Create a new Infomaniak calendar event",
      inputSchema: z.object({
        title: z.string().describe("Event title"),
        start: z.string().describe("Event start time (Date time string)"),
        end: z.string().describe("Event end time (Date time string)"),
        description: z.string().describe("Event description").optional(),
        attendees: z
          .string()
          .describe("List of attendee email addresses as a JSON array")
          .optional(),
        calendar_id: z
          .string()
          .describe("Calendar ID (optional, uses default if not provided)")
          .optional(),
      }),
    },
    async ({
      title,
      start,
      end,
      description,
      attendees,
      calendar_id,
    }) => {
      const response = await calendarClient.createEvent(
        title,
        start,
        end,
        description,
        attendees,
        calendar_id,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response.data) }],
      };
    },
  );

  return server;
}
