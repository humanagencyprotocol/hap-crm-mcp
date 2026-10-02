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
import { SIMULATION_PACKAGE_SCHEMA } from "./simulation-package-schema.js";

const TOOL_DEFINITIONS = [
  // --- Contacts ---
  {
    name: "create_contact",
    description: "Create a new contact in the CRM",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact's full name" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        company: { type: "string", description: "Company or organisation name" },
        role: { type: "string", description: "Job title or role" },
        type: {
          type: "string",
          enum: ["customer", "lead", "partner", "vendor"],
          description: "Contact type (default: customer)",
        },
        stage: {
          type: "string",
          enum: ["new", "active", "inactive", "churned"],
          description: "Lifecycle stage (default: new)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "List of tags",
        },
        notes: { type: "string", description: "Free-form notes" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["name"],
    },
  },
  {
    name: "find_contacts",
    description: "Search for contacts by name, email, company, type, or stage",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text search across name, email, and company" },
        type: {
          type: "string",
          enum: ["customer", "lead", "partner", "vendor"],
          description: "Filter by contact type",
        },
        stage: {
          type: "string",
          enum: ["new", "active", "inactive", "churned"],
          description: "Filter by lifecycle stage",
        },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "update_contact",
    description: "Update fields on an existing contact",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
        role: { type: "string" },
        type: { type: "string", enum: ["customer", "lead", "partner", "vendor"] },
        stage: { type: "string", enum: ["new", "active", "inactive", "churned"] },
        tags: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_contact",
    description: "Delete a contact and all associated activities, deals, and tasks",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["id"],
    },
  },

  // --- Activities ---
  {
    name: "log_activity",
    description: "Log an activity (email, call, meeting, note, or purchase) for a contact",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "Contact ID" },
        type: {
          type: "string",
          enum: ["email", "call", "meeting", "note", "purchase"],
          description: "Activity type",
        },
        summary: { type: "string", description: "Short summary of the activity" },
        detail: { type: "string", description: "Additional detail or body text" },
        date: { type: "string", description: "ISO 8601 date/time (default: now)" },
        created_by: { type: "string", description: "Name or identifier of who logged this" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["contact_id", "type", "summary"],
    },
  },
  {
    name: "get_timeline",
    description: "Get the activity timeline for a contact",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "Contact ID" },
        limit: { type: "number", description: "Maximum activities to return (default: 20)" },
      },
      required: ["contact_id"],
    },
  },

  // --- Deals ---
  {
    name: "create_deal",
    description: "Create a new deal linked to a contact",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "Contact ID" },
        title: { type: "string", description: "Deal title" },
        value: { type: "number", description: "Deal value" },
        currency: { type: "string", description: "Currency code (default: USD)" },
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
          description: "Pipeline stage (default: lead)",
        },
        expected_close: { type: "string", description: "Expected close date (ISO 8601)" },
        notes: { type: "string", description: "Notes about the deal" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["contact_id", "title"],
    },
  },
  {
    name: "update_deal",
    description: "Update fields on an existing deal",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Deal ID" },
        title: { type: "string" },
        value: { type: "number" },
        currency: { type: "string" },
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
        },
        expected_close: { type: "string" },
        notes: { type: "string" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["id"],
    },
  },
  {
    name: "get_pipeline",
    description: "Get deals in the pipeline, optionally filtered by stage",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
          description: "Filter to a specific pipeline stage",
        },
        sort_by: {
          type: "string",
          enum: ["expected_close", "value", "created_at", "updated_at", "title"],
          description: "Field to sort by (default: expected_close)",
        },
      },
      required: [],
    },
  },

  // --- Tasks ---
  {
    name: "create_task",
    description: "Create a task, optionally linked to a contact and/or deal",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        contact_id: { type: "string", description: "Contact ID (optional)" },
        deal_id: { type: "string", description: "Deal ID (optional)" },
        due_date: { type: "string", description: "Due date (ISO 8601)" },
        assigned_to: { type: "string", description: "Name or identifier of assignee" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks, optionally filtered by status, contact, deal, or assignee",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "done"],
          description: "Filter by status (default: open)",
        },
        contact_id: { type: "string", description: "Filter by contact ID" },
        deal_id: { type: "string", description: "Filter by deal ID" },
        assigned_to: { type: "string", description: "Filter by assignee" },
      },
      required: [],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as done",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["id"],
    },
  },

  // --- Export ---
  {
    name: "export_crm",
    description: "Export all CRM data (contacts, activities, deals, tasks) as JSON",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // --- Simulation setup ---
  {
    name: "load_simulation",
    description:
      "Simulation mode only: load a simulation package (name, currency, customers, optional contacts) into this " +
      "connector's simulated CRM. Create only — refused if test data was already loaded, or if any contact, deal, " +
      "task, or activity already exists. Not available in live mode.",
    inputSchema: {
      type: "object",
      properties: {
        package: { ...SIMULATION_PACKAGE_SCHEMA, description: `${SIMULATION_PACKAGE_SCHEMA.description} This connector loads \`name\`, \`currency\`, \`customers\` (as contacts) and optional \`contacts\`; \`products\` and \`cases\` are used by the ERP and the email simulator.` },
        receipt_id: { type: "string", description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this." },
      },
      required: ["package"],
    },
  },
] as const;

async function main() {
  // `crm-mcp export` is a local operator command, not an MCP tool.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const db = await createDb();
  console.error(`[crm-mcp] mode: ${mode}`);

  const server = new Server(
    { name: "crm", version: "1.1.1" },
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
