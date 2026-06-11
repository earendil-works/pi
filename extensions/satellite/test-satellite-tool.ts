import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";

const server = new McpServer({
  name: "test",
  version: "1.0.0",
});

const TOOL_SCHEMAS = {
  read_file: z.object({ path: z.string() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  edit_file: z.object({
    path: z.string(),
    edits: z.array(z.object({
      oldText: z.string(),
      newText: z.string(),
    })),
  }),
  bash: z.object({ command: z.string(), timeout: z.number().optional(), cwd: z.string().optional() }),
  list_dir: z.object({ path: z.string(), limit: z.number().optional() }),
};

server.tool(
  "remote_exec",
  "Execute a tool on the remote server.",
  {
    tool: z.enum(["read_file", "write_file", "edit_file", "bash", "list_dir"]),
    args: z.object({}).passthrough(),
  },
  async (args) => {
    const tool = args.tool as string;
    const toolArgs = args.args as Record<string, unknown>;
    
    const schema = TOOL_SCHEMAS[tool as keyof typeof TOOL_SCHEMAS];
    if (!schema) {
      return { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true };
    }
    
    const parsed = schema.safeParse(toolArgs);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Validation error` }], isError: true };
    }
    
    return { content: [{ type: "text", text: `OK: ${tool}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
