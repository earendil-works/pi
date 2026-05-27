import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// MCP Config (~/.pi/agent/mcp.json)
// ============================================================================

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function loadMcpConfig(): Record<string, McpServerConfig> {
  const configPath = join(homedir(), ".pi", "agent", "mcp.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

// ============================================================================
// JSON Schema → TypeBox
// ============================================================================

function jsonSchemaToTypebox(schema: Record<string, unknown>): ReturnType<typeof Type.Object> {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];
  if (!properties) return Type.Object({});

  const props: Record<string, any> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const s = prop as Record<string, unknown>;
    let field: any;
    switch (s.type) {
      case "number": field = Type.Number({ description: s.description as string }); break;
      case "boolean": field = Type.Boolean({ description: s.description as string }); break;
      default: field = Type.String({ description: s.description as string });
    }
    props[key] = required.includes(key) ? field : Type.Optional(field);
  }
  return Type.Object(props);
}

// ============================================================================
// Extension: Standard MCP — register tools, lazy connect
// ============================================================================

export default function satelliteExtension(pi: ExtensionAPI): void {
  const mcpConfig = loadMcpConfig();
  const serverEntries = Object.entries(mcpConfig);
  if (serverEntries.length === 0) return;

  console.log(`[Satellite] MCP config found: ${serverEntries.map(([n]) => n).join(", ")}`);

  for (const [name, config] of serverEntries) {
    let client: Client | null = null;
    let connecting = false;
    let mcpTools: any[] = [];

    async function ensureConnected(): Promise<void> {
      if (client) return;
      if (connecting) { while (connecting) await new Promise((r) => setTimeout(r, 50)); return; }
      connecting = true;
      try {
        client = new Client({ name: "pi", version: "1.0.0" }, { capabilities: {} });
        const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: "pipe" });
        await client.connect(transport);
        const result = await client.listTools();
        mcpTools = result.tools.map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema }));
        console.log(`[Satellite] ${name}: connected (${mcpTools.map((t) => t.name).join(", ")})`);
      } catch (e) {
        client = null;
        throw e;
      } finally {
        connecting = false;
      }
    }

    // Register tools synchronously (connection is lazy)
    for (const toolDef of [
      { name: "read_file", desc: "Read file content", params: Type.Object({ path: Type.String({ description: "File path" }) }) },
      { name: "write_file", desc: "Write file content", params: Type.Object({ path: Type.String({ description: "File path" }), content: Type.String({ description: "Content" }) }) },
      { name: "edit_file", desc: "Edit file (replace string)", params: Type.Object({ path: Type.String({ description: "File path" }), old_string: Type.String({ description: "Find" }), new_string: Type.String({ description: "Replace" }) }) },
      { name: "bash", desc: "Execute shell command", params: Type.Object({ command: Type.String({ description: "Command" }), cwd: Type.Optional(Type.String({ description: "Working dir" })) }) },
      { name: "list_dir", desc: "List directory", params: Type.Object({ path: Type.String({ description: "Directory path" }) }) },
    ]) {
      pi.registerTool({
        name: toolDef.name,
        label: toolDef.name,
        description: `[MCP:${name}] ${toolDef.desc} on remote server`,
        promptSnippet: `[MCP:${name}] ${toolDef.name}: ${toolDef.desc} on remote server`,
        parameters: toolDef.params,
        execute: async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
          try {
            await ensureConnected();
            if (!client) return { content: [{ type: "text" as const, text: "Not connected" }], details: {} };
            const result = await client.callTool({ name: toolDef.name, arguments: params });
            if (Array.isArray(result.content)) {
              const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
              return { content: [{ type: "text" as const, text }], details: {} };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(result.content) }], details: {} };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text" as const, text: `MCP error: ${msg}` }], details: {} };
          }
        },
      });
    }
  }
}
