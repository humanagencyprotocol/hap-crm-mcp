/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
import { SIMULATION_PACKAGE_SCHEMA } from "../simulation-package-schema.js";
import { SIMULATION_PACKAGE_GUIDE } from "../simulation-package-guide.js";

const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

const CONTACT_TYPE_FIELD = {
  type: "string" as const,
  enum: ["customer", "lead", "partner", "vendor"],
  description:
    "Required — the contact type this call acts on (for a task without a contact: the type it is for). Checked against the contact's actual stored type; refused if missing or on mismatch.",
};

const REVISION_FIELD = (doc: string) => ({
  type: "number" as const,
  description: `The ${doc}'s current revision — refused if the ${doc} has moved on to a later one since this number was read.`,
});

const CONTACT_OUTPUT_PROPERTIES = {
  id: { type: "string", title: "Contact ID", description: "Unique identifier for this contact" },
  name: { type: "string", title: "Name", description: "Contact's full name" },
  email: { type: ["string", "null"], title: "Email", description: "Email address" },
  phone: { type: ["string", "null"], title: "Phone", description: "Phone number" },
  company: { type: ["string", "null"], title: "Company", description: "Company or organisation name" },
  role: { type: ["string", "null"], title: "Role", description: "Job title or role" },
  type: { type: "string", title: "Type", enum: ["customer", "lead", "partner", "vendor"], description: "Contact type" },
  stage: { type: "string", title: "Stage", enum: ["new", "active", "inactive", "churned"], description: "Lifecycle stage" },
  tags: { type: "array", items: { type: "string" }, title: "Tags", description: "List of tags" },
  notes: { type: ["string", "null"], title: "Notes", description: "Free-form notes" },
  archived: { type: "boolean", title: "Archived", description: "Whether this contact has been archived" },
  revision: { type: "number", title: "Revision", description: "The current revision of this contact's content" },
  created_at: { type: "string", title: "Created at", description: "When this contact was created" },
  updated_at: { type: "string", title: "Updated at", description: "When this contact's content was last changed" },
};

const DEAL_OUTPUT_PROPERTIES = {
  id: { type: "string", title: "Deal ID", description: "Unique identifier for this deal" },
  contact_id: { type: "string", title: "Contact ID", description: "The contact this deal is linked to" },
  title: { type: "string", title: "Title", description: "Deal title" },
  value: { type: ["number", "null"], title: "Value", description: "Deal value" },
  currency: { type: "string", title: "Currency", description: "Currency code" },
  stage: {
    type: "string",
    title: "Stage",
    enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
    description: "Pipeline stage",
  },
  expected_close: { type: ["string", "null"], title: "Expected close", description: "Expected close date" },
  notes: { type: ["string", "null"], title: "Notes", description: "Notes about the deal" },
  revision: { type: "number", title: "Revision", description: "The current revision of this deal's content" },
  created_at: { type: "string", title: "Created at", description: "When this deal was created" },
  updated_at: { type: "string", title: "Updated at", description: "When this deal's content was last changed" },
};

const TASK_OUTPUT_PROPERTIES = {
  id: { type: "string", title: "Task ID", description: "Unique identifier for this task" },
  contact_id: { type: ["string", "null"], title: "Contact ID", description: "The contact this task is linked to, if any" },
  deal_id: { type: ["string", "null"], title: "Deal ID", description: "The deal this task is linked to, if any" },
  title: { type: "string", title: "Title", description: "Task title" },
  due_date: { type: ["string", "null"], title: "Due date", description: "Due date" },
  status: { type: "string", title: "Status", enum: ["open", "done"], description: "Task status" },
  assigned_to: { type: ["string", "null"], title: "Assigned to", description: "Name or identifier of assignee" },
  revision: { type: "number", title: "Revision", description: "The current revision of this task's content" },
  created_at: { type: "string", title: "Created at", description: "When this task was created" },
};

export const TOOL_DEFINITIONS = [
  // --- Contacts ---
  {
    name: "create_contact",
    description: "Create a new contact in the CRM. The result's `revision` is always 1.",
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
        ticket_id: TICKET_FIELD,
      },
      required: ["name", "type"],
    },
  },
  {
    name: "find_contacts",
    description:
      "Search for contacts by name, email, company, type, or stage. Archived contacts are excluded by default " +
      "— pass include_archived to see them too. Each result includes its current revision.",
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
        include_archived: { type: "boolean", description: "Include archived contacts (default: false)" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_contact",
    description:
      "Get a single contact, including its current revision. Pass `revision` to get an earlier revision's " +
      "content instead (archived status and timestamps still reflect the contact as it is now).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        revision: { type: "number", description: "Optional — return this past revision's content instead of the current one" },
      },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: CONTACT_OUTPUT_PROPERTIES,
      required: ["id", "name", "type", "stage", "archived", "revision"],
    },
  },
  {
    name: "update_contact",
    description:
      "Update fields on an existing contact. Requires the contact's current `revision` — refused, naming both " +
      "revisions, if the contact was changed since that revision was read; refused if the contact is archived " +
      "(restore it first). The `type` field cannot be changed here — use convert_contact. Every successful " +
      "update produces the next revision.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        revision: REVISION_FIELD("contact"),
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
        role: { type: "string" },
        stage: { type: "string", enum: ["new", "active", "inactive", "churned"] },
        tags: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "contact_type"],
    },
  },
  {
    name: "delete_contact",
    description:
      "Archive a contact (does not delete it or its activities/deals/tasks, and does not cascade). Requires the " +
      "contact's current `revision` — refused, naming both revisions, if the contact was changed since that " +
      "revision was read; refused if the contact is already archived. An archived contact is excluded from " +
      "find_contacts and get_pipeline by default, and can be brought back with restore_contact.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        revision: REVISION_FIELD("contact"),
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "contact_type"],
    },
  },
  {
    name: "restore_contact",
    description:
      "Bring an archived contact back (the opposite of delete_contact). Requires the contact's current " +
      "`revision` — refused, naming both revisions, if it changed since that revision was read; refused if the " +
      "contact is not archived.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        revision: REVISION_FIELD("contact"),
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "contact_type"],
    },
  },
  {
    name: "convert_contact",
    description:
      "Change a contact's type (e.g. lead to customer) as its own, logged action — the only way to change type " +
      "once a contact exists (update_contact refuses it). Requires the contact's current `revision` — refused, " +
      "naming both revisions, if it changed since that revision was read; refused if the contact is already " +
      "that type, or is archived.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Contact ID" },
        revision: REVISION_FIELD("contact"),
        to_type: {
          type: "string",
          enum: ["customer", "lead", "partner", "vendor"],
          description: "The type to convert this contact to",
        },
        contact_type: {
          type: "string" as const,
          description:
            "Required — both types, the current and the new one, as \"<current>,<new>\" (e.g. \"lead,customer\"). The current type is checked against the contact's stored type, the new one must equal to_type.",
        },
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "to_type", "contact_type"],
    },
  },

  // --- Activities ---
  {
    name: "log_activity",
    description:
      "Log an activity (email, call, meeting, note, or purchase) for a contact. Append-only: there is no tool " +
      "to edit or delete a logged activity — a correction is a new activity.",
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
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["contact_id", "type", "summary", "contact_type"],
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
    description: "Create a new deal linked to a contact. The result's `revision` is always 1.",
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
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["contact_id", "title", "contact_type"],
    },
  },
  {
    name: "update_deal",
    description:
      "Update fields on an existing deal. Requires the deal's current `revision` — refused, naming both " +
      "revisions, if the deal was changed since that revision was read. Every successful update produces the " +
      "next revision.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Deal ID" },
        revision: REVISION_FIELD("deal"),
        title: { type: "string" },
        value: { type: "number" },
        currency: { type: "string" },
        stage: {
          type: "string",
          enum: ["lead", "qualified", "proposal", "negotiation", "won", "lost"],
        },
        expected_close: { type: "string" },
        notes: { type: "string" },
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "contact_type"],
    },
  },
  {
    name: "get_deal",
    description:
      "Get a single deal, including its current revision. Pass `revision` to get an earlier revision's " +
      "content instead (timestamps still reflect the deal as it is now).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Deal ID" },
        revision: { type: "number", description: "Optional — return this past revision's content instead of the current one" },
      },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: DEAL_OUTPUT_PROPERTIES,
      required: ["id", "contact_id", "title", "stage", "revision"],
    },
  },
  {
    name: "get_pipeline",
    description:
      "Get deals in the pipeline, optionally filtered by stage. Deals whose contact is archived are excluded by " +
      "default — pass include_archived to see them too.",
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
        include_archived: { type: "boolean", description: "Include deals whose contact is archived (default: false)" },
      },
      required: [],
    },
  },

  // --- Tasks ---
  {
    name: "create_task",
    description: "Create a task, optionally linked to a contact and/or deal. The result's `revision` is always 1.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        contact_id: { type: "string", description: "Contact ID (optional)" },
        deal_id: { type: "string", description: "Deal ID (optional)" },
        due_date: { type: "string", description: "Due date (ISO 8601)" },
        assigned_to: { type: "string", description: "Name or identifier of assignee" },
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["title", "contact_type"],
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
    name: "get_task",
    description:
      "Get a single task, including its current revision. Pass `revision` to get an earlier revision's " +
      "content instead (created_at still reflects the task as it is now).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        revision: { type: "number", description: "Optional — return this past revision's content instead of the current one" },
      },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      properties: TASK_OUTPUT_PROPERTIES,
      required: ["id", "title", "status", "revision"],
    },
  },
  {
    name: "complete_task",
    description:
      "Mark a task as done. Requires the task's current `revision` — refused, naming both revisions, if the " +
      "task was changed since that revision was read.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        revision: REVISION_FIELD("task"),
        contact_type: CONTACT_TYPE_FIELD,
        ticket_id: TICKET_FIELD,
      },
      required: ["id", "revision", "contact_type"],
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
      "task, or activity already exists; clear_simulation empties it first. Not available in live mode. " + SIMULATION_PACKAGE_GUIDE,
    inputSchema: {
      type: "object",
      properties: {
        package: { ...SIMULATION_PACKAGE_SCHEMA, description: `${SIMULATION_PACKAGE_SCHEMA.description} This connector loads \`name\`, \`currency\`, \`customers\` (as contacts) and optional \`contacts\`; \`products\` and \`cases\` are used by the ERP and the email simulator.` },
        ticket_id: TICKET_FIELD,
      },
      required: ["package"],
    },
  },
  {
    name: "clear_simulation",
    description:
      "Simulation mode only: delete all test data from this connector's simulated CRM — contacts, activities, deals, " +
      "tasks, and the record of changes and refusals — so a new package can be loaded with load_simulation. " +
      "Cannot be undone. Not available in live mode.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_FIELD,
      },
      required: [],
    },
  },
] as const;
