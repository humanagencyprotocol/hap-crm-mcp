# CRM connector contract

This describes the contract this connector keeps with any caller — the tools,
their arguments, and the refusal rules — independent of what runs behind it
(a simulated database today; a real CRM behind a live adapter later). It is
vendor-neutral by design: nothing here names a product, a specific
governance layer, or a gating mechanism. A caller only needs this document
and the tool list the server advertises.

## The revision rule

This section states the rule independent of what kind of record it applies
to — it is the same rule any connector with this kind of contract uses for a
record that can be changed after creation (see the ERP connector's quote
revisions for another instance of it). See *Contacts, deals, and tasks and
the revision rule* below for how this connector's three record types apply
it.

A record that can be changed after creation, and that a caller later acts on
by name (updates it, archives it, converts it, completes it — anything
beyond reading it), carries an integer **revision**, starting at 1:

- **Any change to the record's content creates the next revision.** Creation
  is revision 1. Every change that succeeds afterward produces the next
  integer — regardless of whether the change looks material (an update that
  only touches a note, or restates the same stage it already had, still
  produces a new revision; the revision tracks the record's actual content,
  not a judgement about whether the content "really" changed).
- **A revision, once created, never changes.** Its content is frozen the
  moment the next revision exists. A caller can always retrieve a past
  revision by number.
- **An action that acts on the record's content names the revision it acts
  on.** It takes a `revision` argument and is refused if the record is no
  longer at that revision. This is what makes a request like "update this"
  or "mark this done" bind to one exact version of the record, even if the
  record changed between the moment the request was made (and perhaps
  decided on by a person) and the moment it was actually carried out.
- **A revision mismatch is refused by naming both revisions** — the one the
  caller declared and the record's actual current one — the same way every
  other declared-value mismatch is refused in this connector (see *Refusal
  shape* below). Nothing about the record changes when this refusal happens.
- **Old revisions are kept.** Nothing a caller can do erases an earlier
  revision's content.

This follows ordinary optimistic-locking practice (compare-and-refuse on a
version number) and is not unusual among CRM systems: an edit to a record
a person is reviewing must bind to the version they are looking at, not to
"whatever the record contains by the time the edit runs."

## Contacts, deals, and tasks and the revision rule

This connector has three record types that carry a revision: the
**contact**, the **deal**, and the **task**. `create_contact`, `create_deal`,
and `create_task` always produce revision 1; every successful
`update_contact`, `delete_contact`, `restore_contact`, `convert_contact`,
`update_deal`, and `complete_task` produces the next revision for the
record it acted on, and all six require a `revision` argument, refused
(naming both revisions) if the record is no longer at that revision.

**Activities are append-only and carry no revision.** There is no tool to
edit or delete a logged activity — a correction is a new activity, not a
change to a past one. Nothing ever acts on a past activity by name, so the
revision rule does not apply to it.

## Contacts are archived, never deleted

`delete_contact` archives a contact — it does not delete it, and it does not
cascade. A contact's activities, deals, and tasks are untouched by
archiving it: they stay exactly as they were. This differs from the revision
rule's other actions only in what it does to the record (it does not change
the contact's visible fields, just its archived state), not in how it works:
it still requires the contact's current `revision`, still produces the next
one, and is refused the same way on a stale revision.

- An archived contact is excluded from `find_contacts` and `get_pipeline` by
  default (an `include_archived` argument opts back in).
- `restore_contact` is the inverse of `delete_contact`: it un-archives a
  contact. It requires the current `revision` the same way; it is refused if
  the contact is not archived.
- Every other write on a contact (`update_contact`, `convert_contact`, and
  `delete_contact` itself) is refused if the contact is already archived —
  restore it first.

## convert_contact — the only way to change a contact's type

`update_contact` never changes a contact's `type` — passing `type` to it is
refused, naming `convert_contact` as the way to do it. Changing a contact's
type (for example, a lead becoming a customer) is its own action,
`convert_contact { id, revision, to_type }`, logged as its own entry in the
change record. It follows the revision rule like any other write on a
contact, and is refused if `to_type` equals the contact's current type, or if
the contact is archived.

## The contact_type scope check

Every tool that writes to an existing contact, or to a deal, activity, or
task tied to one, accepts an optional `contact_type` argument: the type a
governing layer outside this connector is authorizing the call for (a
"customers only" authority, for example). When present, the connector
compares it against the contact's **real stored type** — not a claim passed
in by whatever authorized the call — and refuses on mismatch, naming both
types. An absent `contact_type` makes no claim and is not checked.

This applies to `update_contact`, `delete_contact`, `restore_contact` (via
the contact itself), `convert_contact`, `log_activity`, `create_deal`,
`update_deal` (via the deal's own `contact_id`), and `create_task` (when a
`contact_id` is given).

## Tools

### Reads

| Tool | Returns |
|---|---|
| `find_contacts` | contacts, each including its current `revision`; archived contacts excluded unless `include_archived` |
| `get_contact` | a contact, including its current `revision`; an optional `revision` argument returns that exact historical version instead |
| `get_timeline` | a contact's activities |
| `get_pipeline` | deals, each including its current `revision`; deals whose contact is archived excluded unless `include_archived` |
| `get_deal` | a deal, including its current `revision`; an optional `revision` argument returns that exact historical version instead |
| `list_tasks` | tasks, each including its current `revision` |
| `get_task` | a task, including its current `revision`; an optional `revision` argument returns that exact historical version instead |
| `export_crm` | everything, as JSON |

### Changes

| Tool | Effect | Revision |
|---|---|---|
| `create_contact` | creates a contact | produces revision 1 |
| `update_contact` | changes a contact's fields (not `type`) | requires the current revision; produces the next |
| `delete_contact` | archives a contact (no cascade) | requires the current revision; produces the next |
| `restore_contact` | un-archives a contact | requires the current revision; produces the next |
| `convert_contact` | changes a contact's `type` | requires the current revision; produces the next |
| `log_activity` | appends an activity to a contact's timeline | — (activities carry no revision) |
| `create_deal` | creates a deal linked to a contact | produces revision 1 |
| `update_deal` | changes a deal's fields | requires the current revision; produces the next |
| `create_task` | creates a task, optionally linked to a contact and/or deal | produces revision 1 |
| `complete_task` | marks a task done | requires the current revision; produces the next |

## How a caller learns the current revision

The revision of a contact, deal, or task is always in the result of
whichever call most recently touched or read it: every create/update/
archive/restore/convert/complete call, and every read-by-id call
(`get_contact`, `get_deal`, `get_task`), include it. A caller preparing a
call that requires `revision` reads the record first (or uses the revision
returned by the call that produced the version it intends to act on) and
passes that number back.

## Refusal shape

Every refusal in this connector follows one shape: a message naming the
field, what was declared, and what was expected or actual. For the revision
rule specifically, the message names both revisions explicitly, in the form

> `<Record kind> <id> is at revision <N>; this request is for revision <M>.`

for example:

> Contact c-12 is at revision 2; this request is for revision 1.

For the `contact_type` scope check, the message names both types, in the
form

> `Contact <name> (<id>) is type "<actual>"; this request declares "<declared>".`

Nothing is read, written, or changed by a refused call.
