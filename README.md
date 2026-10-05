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

### Test setup (simulation mode only)

| Tool | Description |
|------|-------------|
| `load_simulation` | Load a simulation package into the empty CRM — create only |
| `clear_simulation` | Delete all test data so a new package can be loaded |

These two are not part of the work the agent is tested on; see [Simulation mode](#simulation-mode).

---

## Database

**SQLite (default)** — zero config. Data stored at `~/.hap/crm.db`. Auto-backup to `crm.backup.db` daily.

**Postgres** — set `DATABASE_URL` to a connection string. For teams where multiple gateways need shared access.

Schema is created automatically on first start.

---

## Simulation mode

The connector has a switch, `CRM_MODE`:

| Mode | What answers | Status |
|---|---|---|
| `simulation` (default) | the built-in simulated CRM (the database above) | available |
| `live` | the company's real CRM | no adapter in 0.x — **every call is refused**, reads included, with a clear message; nothing is read or changed |

The point: a three-week test runs on exactly this connector, its 13 tools and its
HAP `customers` profile. Only the system behind it is simulated, so the tickets
issued during the test are the same tickets that will be issued live. Going live
= switch the mode and connect the real system; mandates and agent setup stay as
they are. An unknown `CRM_MODE` value stops the server at start rather than
guessing.

**Company file.** `CRM_COMPANY_FILE=/path/to/company.json` seeds an empty
database with contacts — one `customer`-type contact per entry in the file's
`customers[]`. The format is the **same company file the ERP connector reads**
(`name`, `currency`, `items`, `customers[...]`), so one file can describe the
whole simulated world for a pilot that runs both connectors; the ERP's `items`
are accepted and validated here for compatibility but otherwise unused. An
optional top-level `contacts[]` extends that world with CRM-native records
(leads, partners, vendors) the ERP has no concept of — `name`, `email`, `phone`,
`company`, `role`, `type`, `stage`, `tags`, `notes`. The file is validated
strictly and refused whole on the first problem, naming the field. Without a
company file the database starts empty, as before. **Still the way to go for
local development** — loaded at connector start. Example:
[`examples/company.example.json`](examples/company.example.json).

**`load_simulation` (MCP tool).** The gateway-facing way to load test data: a
simulation package — `{ name, currency, customers: [...], contacts?: [...] }`
— passed as the `package` argument, in the same flat format the ERP connector
and the email simulator use (each reads only the parts it needs; the ERP's
`products`/`items` and the email simulator's `cases` are accepted and ignored
here). Simulation mode only; refused in live mode like every other tool.
**Create only, never edit** — refused once test data was already loaded, or
any contact, deal, task, or activity already exists for any reason (including
one seeded by `CRM_COMPANY_FILE`, since that did not come from an earlier
load). Records the
package's name and the SHA-256 of its canonical (key-order-independent) JSON
in `simulation_load`. Example package:
[`examples/package.example.json`](examples/package.example.json).

**`clear_simulation` (MCP tool).** Deletes all test data — contacts, activities,
deals, tasks, and the record of changes and refusals — so the same cases can run
again under a different setup, or other cases under the same one: clear, then
load. Simulation mode only; refused in live mode. The clear itself stays recorded
as one change with its `receipt_id`; that entry does not block the next load.
Cannot be undone — take an `export` first if you want to keep the record.

**Changes.** Every successful call to a write tool (`create_contact`,
`update_contact`, `delete_contact`, `log_activity`, `create_deal`,
`update_deal`, `create_task`, `complete_task`, `load_simulation`,
`clear_simulation`) is recorded
as its own entry in `changes` — time, tool, the affected document's id, a
short summary, and the `receipt_id` the gateway injected. `delete_contact`
and `complete_task` now declare `receipt_id` too (additive); `delete_contact`
still has no surviving row to store it on, so only the change record carries
it. Reads record nothing.

**Refusals after the gateway.** When the connector refuses a write call the
gateway already let through (unknown id, a bad state), it records the refusal
in `refusals` with the `receipt_id` the gateway injected (or `null`, where no
row survives to carry it). A ticket then exists for an action that never
happened, and this record is the only place that says so.

**Local command** (not an MCP tool — the agent can neither read nor change it).
Point it at the same database the gateway uses — for a gateway install that is
`HAP_DATA_DIR=~/.suveren`:

```bash
HAP_DATA_DIR=~/.suveren crm-mcp export > record.json   # contacts, deals, tasks, activities, changes, refusals, simulation_load, mode
```

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
