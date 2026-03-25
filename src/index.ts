#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { create_contact, find_contacts, update_contact, delete_contact } from "./tools/contacts.js";
import { log_activity, get_timeline } from "./tools/activities.js";
import { create_deal, update_deal, get_pipeline } from "./tools/deals.js";
import { create_task, list_tasks, complete_task } from "./tools/tasks.js";
import { export_crm } from "./tools/export.js";

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
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

async function main() {
  const db = await createDb();

  const server = new Server(
    { name: "crm", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      let result: unknown;

      switch (name as ToolName) {
        case "create_contact":
          result = await create_contact(db, safeArgs);
          break;
        case "find_contacts":
          result = await find_contacts(db, safeArgs);
          break;
        case "update_contact":
          result = await update_contact(db, safeArgs);
          break;
        case "delete_contact":
          result = await delete_contact(db, safeArgs);
          break;
        case "log_activity":
          result = await log_activity(db, safeArgs);
          break;
        case "get_timeline":
          result = await get_timeline(db, safeArgs);
          break;
        case "create_deal":
          result = await create_deal(db, safeArgs);
          break;
        case "update_deal":
          result = await update_deal(db, safeArgs);
          break;
        case "get_pipeline":
          result = await get_pipeline(db, safeArgs);
          break;
        case "create_task":
          result = await create_task(db, safeArgs);
          break;
        case "list_tasks":
          result = await list_tasks(db, safeArgs);
          break;
        case "complete_task":
          result = await complete_task(db, safeArgs);
          break;
        case "export_crm":
          result = await export_crm(db, safeArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

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
