# HAP CRM MCP Server

A simple CRM for AI agents, built as an [MCP](https://modelcontextprotocol.io) server and gated through the [Human Agency Protocol](https://humanagencyprotocol.org).

> **@humanagencyp/crm-mcp** — [npm](https://www.npmjs.com/package/@humanagencyp/crm-mcp)

---

## What It Does

Four entities. Thirteen tools. One database file.

- **Contacts** — people you interact with (customers, leads, partners, vendors)
- **Activities** — what happened (emails, calls, meetings, notes, purchases)
- **Deals** — what's in play (pipeline stages, values, expected close)
- **Tasks** — what's next (follow-ups linked to contacts or deals)

Every write operation is gated through the HAP `customers` profile — your agent can only create contacts, log activities, or manage deals within the bounds you authorize.

---

## Quick Start

### With HAP Gateway

The CRM is available as a built-in integration. Go to **Integrations** in the gateway UI, activate **CRM**, and you're done. No configuration needed.

### Standalone

```bash
npx @humanagencyp/crm-mcp@latest
```

This starts the MCP server with a SQLite database at `~/.hap/crm.db`.

For Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/mydb npx @humanagencyp/crm-mcp@latest
```

---

## Tools

### Contacts

| Tool | Description |
|------|-------------|
| `create_contact` | Create a new contact (name, email, phone, company, role, type, stage, tags) |
| `find_contacts` | Search by name, email, company, type, or stage |
| `update_contact` | Update any contact field |
| `delete_contact` | Delete a contact and all related activities, deals, tasks |

### Activities

| Tool | Description |
|------|-------------|
| `log_activity` | Log an interaction (email, call, meeting, note, purchase) |
| `get_timeline` | Get activity history for a contact |

### Deals

| Tool | Description |
|------|-------------|
| `create_deal` | Create a deal (title, value, currency, stage, expected close) |
| `update_deal` | Update deal stage, value, or other fields |
| `get_pipeline` | View deals by stage |

### Tasks

| Tool | Description |
|------|-------------|
| `create_task` | Create a task linked to a contact or deal |
| `list_tasks` | List tasks by status, contact, deal, or assignee |
| `complete_task` | Mark a task as done |

### Export

| Tool | Description |
|------|-------------|
| `export_crm` | Full JSON export of all contacts, activities, deals, tasks |

---

## Database

**SQLite (default)** — zero config. Data stored at `~/.hap/crm.db`. Auto-backup to `crm.backup.db` daily.

**Postgres** — set `DATABASE_URL` to a connection string. For teams where multiple gateways need shared access.

Schema is created automatically on first start.

---

## HAP Profile

This server is gated through the `customers` profile:

- **Bounds** — `contact_create_daily_max`, `contact_modify_daily_max`, `activity_create_daily_max`, `deal_create_daily_max`
- **Context** — `contact_type` (customer, lead, partner, vendor), `access_level` (read, write)
- **Paths** — `customers-read` (24h), `customers-write` (8h), `customers-delete` (2h)

---

## License

MIT

See [humanagencyprotocol.org](https://humanagencyprotocol.org) for the full protocol specification.
