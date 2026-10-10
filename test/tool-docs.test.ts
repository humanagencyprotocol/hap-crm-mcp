/**
 * Tool documentation stays vendor-neutral: an MCP server describes its own tools
 * and works the same behind any gateway or AI client, so nothing an agent reads
 * here may name a product or a governance concept (decision 2026-10-02 — those
 * belong to the gateway's manifest and the person's mandate, not the connector).
 * load_simulation carries the shared how-to for building a package.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";
import { SIMULATION_PACKAGE_GUIDE } from "../src/simulation-package-guide.js";

describe("tool documentation", () => {
  const text = JSON.stringify(TOOL_DEFINITIONS);

  it("names no product or governance concept", () => {
    // ticket_id is exempt: it is the HAP v0.7 wire argument name (mandated by
    // the protocol, same treatment the old receipt_id key got) — not prose
    // explaining the gateway's ticket concept to the agent.
    for (const term of [/suveren/i, /mandate/i, /three-week/i, /\bticket(?!_id)/i]) expect(text).not.toMatch(term);
  });

  it("load_simulation carries the how-to for building a package", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "load_simulation")!;
    expect(tool.description).toContain(SIMULATION_PACKAGE_GUIDE);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/real cases/);
    expect(SIMULATION_PACKAGE_GUIDE).toMatch(/person check/);
  });

  it("declares ticket_id, not receipt_id, on every write tool's input schema (v0.7 wire rename)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).not.toHaveProperty("receipt_id");
    }
    const writeTools = ["create_contact", "update_contact", "delete_contact", "restore_contact", "convert_contact", "log_activity", "create_deal", "update_deal", "create_task", "complete_task", "load_simulation", "clear_simulation"];
    for (const name of writeTools) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).toHaveProperty("ticket_id");
    }
  });

  it("requires revision on every action that names an existing contact/deal/task", () => {
    const revisionRequiredTools = ["update_contact", "delete_contact", "restore_contact", "convert_contact", "update_deal", "complete_task"];
    for (const name of revisionRequiredTools) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
      expect(schema.properties).toHaveProperty("revision");
      expect(schema.required).toContain("revision");
    }
  });

  it("requires contact_type on every tool that acts on a contact (checked against the real stored type)", () => {
    const contactTypeRequiredTools = [
      "update_contact", "delete_contact", "restore_contact", "convert_contact",
      "log_activity", "create_deal", "update_deal", "create_task", "complete_task",
    ];
    for (const name of contactTypeRequiredTools) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
      expect(schema.properties, name).toHaveProperty("contact_type");
      expect(schema.required, name).toContain("contact_type");
    }
  });

  it("requires `type` on create_contact — the one tool with no existing contact to check against", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "create_contact")!;
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: readonly string[] };
    expect(schema.properties).toHaveProperty("type");
    expect(schema.required).toContain("type");
  });

  it("declares an outputSchema (for the gateway's approval preview) on every read-by-id tool", () => {
    for (const name of ["get_contact", "get_deal", "get_task"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)! as { outputSchema?: { properties?: Record<string, unknown> } };
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema!.properties).toHaveProperty("revision");
      for (const [key, prop] of Object.entries(tool.outputSchema!.properties!)) {
        expect(prop, `${name}.outputSchema.${key}`).toHaveProperty("title");
        expect(prop, `${name}.outputSchema.${key}`).toHaveProperty("description");
      }
    }
  });
});
