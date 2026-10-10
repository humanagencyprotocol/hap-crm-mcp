#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { callTool } from "./dispatch.js";
import { getMode } from "./mode.js";
import { runCli } from "./cli.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

/** Tools whose definition carries an `outputSchema` — their result is also returned as
 * `structuredContent` (the gateway's approval preview reads this), in addition to the text
 * content every tool already returns. */
const STRUCTURED_RESULT_TOOLS = new Set(["get_contact", "get_deal", "get_task"]);

async function main() {
  // `crm-mcp export` is a local operator command, not an MCP tool.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const db = await createDb();
  console.error(`[crm-mcp] mode: ${mode}`);

  const server = new Server(
    { name: "crm", version: "1.1.2" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      const result = await callTool(db, mode, name, safeArgs);

      const response: Record<string, unknown> = {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
      if (STRUCTURED_RESULT_TOOLS.has(name) && result && typeof result === "object") {
        response.structuredContent = result as Record<string, unknown>;
      }
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[crm-mcp] tool error (${name}):`, message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  process.on("SIGINT", async () => {
    await db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[crm-mcp] server started");
}

main().catch((err) => {
  console.error("[crm-mcp] fatal:", err);
  process.exit(1);
});
