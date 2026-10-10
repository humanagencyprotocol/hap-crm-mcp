# Changelog

## Unreleased

**BREAKING:** every tool that changes something requires `contact_type` (and
`create_contact` requires `type`). A missing or wrong value is refused.

- `contact_type` is required on `update_contact`, `delete_contact`,
  `restore_contact`, `log_activity`, `create_deal`, `update_deal`,
  `create_task` and `complete_task`, and checked against the contact's real
  stored type (a task without a contact must declare a known type).
  Before, an absent value was not checked, so a call could stay silent about
  the type it acted on.
- `convert_contact` declares both types, `"<current>,<new>"`; the current one
  is checked against the stored type, the new one must equal `to_type`.
- `restore_contact` and `complete_task` now check the contact type too;
  `update_deal` checked it only when a value was given — now always.

## 1.4.0

**BREAKING:** changing an existing contact, deal or task now needs its current
`revision` (`update_contact`, `delete_contact`, `update_deal`,
`complete_task`); a stale revision is refused, naming both revisions.

- Contacts, deals and tasks carry an integer `revision` (1 on create, +1 on
  every change); past revisions are kept and readable.
- `delete_contact` archives instead of deleting — no cascade: activities, deals
  and tasks stay. New `restore_contact`. Archived contacts are left out of
  `find_contacts` / `get_pipeline` unless `include_archived`.
- `update_contact` no longer changes `type`; new `convert_contact` does
  (e.g. lead → customer), as its own logged action.
- Optional `contact_type` on writes is checked against the contact's real
  stored type (refused on mismatch).
- New reads by id for approval previews: `get_contact`, `get_deal`, `get_task`
  (`{ id, revision? }`, structured result with an output schema).
- The `changes` log records the new revision and old/new values.
- Existing databases migrate in place on start (idempotent; nothing is lost;
  the old ON DELETE CASCADE is removed).
- Contract: `docs/contract.md`.

## 1.3.0

**BREAKING:** the tool argument `receipt_id` is now `ticket_id` (HAP v0.7
vocabulary); the Suveren gateway fills it — use gateway v0.7 or later.

This is a breaking change on the wire, released as a minor by the owner's
decision (pre-1.0, one implementation). Internal SQLite storage is unaffected:
the `receipt_id` column name on the `contacts`, `activities`, `deals`,
`tasks`, `changes`, and `refusals` tables is unchanged — it now stores the
value supplied under the `ticket_id` argument.
