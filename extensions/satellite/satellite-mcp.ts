#!/usr/bin/env bun
/**
 * Satellite MCP Server
 *
 * An MCP server that exposes remote file and shell tools via stdio transport.
 * Deploys on the remote server and connects via SSH.
 *
 * Exposes a single `remote_exec` tool that routes to 5 predefined tools:
 * read_file, write_file, edit_file, bash, list_dir.
 *
 * Logs go to stderr (stdout is reserved for MCP protocol).
 * View logs: ssh server 'tail -f /tmp/satellite.log' or check stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { z } from "zod";

// ============================================================================
// Logging (stderr + optional file)
// ============================================================================

const LOG_FILE = "/tmp/satellite.log";

try { mkdirSync("/tmp", { recursive: true }); } catch { /* ignore */ }

function log(msg: string): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const line = `[${ts}] ${msg}`;
  process.stderr.write(line + "\n");
  try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

// ============================================================================
// Helpers
// ============================================================================

function textContent(text: string) {
	return [{ type: "text" as const, text }];
}

// ============================================================================
// CWD State (maintained across tool calls)
// ============================================================================

let bashCwd = "/";

// ============================================================================
// Tool Validation Schemas
// ============================================================================

const TOOL_SCHEMAS = {
  read_file: z.object({ path: z.string() }),
  write_file: z.object({ path: z.string(), content: z.string() }),
  edit_file: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  bash: z.object({ command: z.string(), cwd: z.string().optional() }),
  list_dir: z.object({ path: z.string() }),
};

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleReadFile(args: { path: string }) {
  const t0 = Date.now();
  try {
    const content = await readFile(args.path, "utf-8");
    log(`read_file ${args.path} → ok ${Date.now() - t0}ms (${content.length} bytes)`);
    return { content: textContent(content) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`read_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleWriteFile(args: { path: string; content: string }) {
  const t0 = Date.now();
  try {
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf-8");
    log(`write_file ${args.path} → ok ${Date.now() - t0}ms (${args.content.length} bytes)`);
    return { content: textContent("OK") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`write_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleEditFile(args: { path: string; old_string: string; new_string: string }) {
  const t0 = Date.now();
  try {
    const content = await readFile(args.path, "utf-8");
    if (!content.includes(args.old_string)) {
      log(`edit_file ${args.path} → error ${Date.now() - t0}ms: string not found`);
      return { content: textContent(`Error: String not found: ${args.old_string}`), isError: true };
    }
    const updated = content.replace(args.old_string, args.new_string);
    await writeFile(args.path, updated, "utf-8");
    log(`edit_file ${args.path} → ok ${Date.now() - t0}ms`);
    return { content: textContent("OK") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`edit_file ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleBash(args: { command: string; cwd?: string }) {
  const workDir = args.cwd || bashCwd;
  const t0 = Date.now();
  try {
    const proc = Bun.spawn(["sh", "-c", args.command], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    // 120s timeout
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, 120_000);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const duration = Date.now() - t0;

    // Update CWD if command contains cd
    if (args.command.includes("cd ")) {
      try {
        const testProc = Bun.spawn(["sh", "-c", `cd ${workDir} && ${args.command} && pwd`], { stdout: "pipe" });
        await testProc.exited;
        const newCwd = (await new Response(testProc.stdout).text()).trim();
        if (newCwd) bashCwd = newCwd;
      } catch { /* ignore */ }
    }

    const output = [];
    if (stdout) output.push(stdout);
    if (stderr) output.push(`stderr: ${stderr}`);
    if (exitCode !== 0) output.push(`exit code: ${exitCode}`);

    log(`bash "${args.command.slice(0, 80)}" → ${exitCode === 0 ? "ok" : "error"} ${duration}ms`);
    return { content: textContent(output.join("\n") || "(no output)") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`bash "${args.command.slice(0, 80)}" → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

async function handleListDir(args: { path: string }) {
  const t0 = Date.now();
  try {
    const dirEntries = await readdir(args.path, { withFileTypes: true });
    const entries: Array<{ name: string; type: string; size: number }> = [];
    for (const entry of dirEntries) {
      const fullPath = join(args.path, entry.name);
      const file = Bun.file(fullPath);
      entries.push({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: file.size,
      });
    }
    log(`list_dir ${args.path} → ok ${Date.now() - t0}ms (${entries.length} entries)`);
    return { content: textContent(JSON.stringify(entries, null, 2)) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`list_dir ${args.path} → error ${Date.now() - t0}ms: ${msg}`);
    return { content: textContent(`Error: ${msg}`), isError: true };
  }
}

// ============================================================================
// Tool Router
// ============================================================================

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>> = {
  read_file: (args) => handleReadFile(args as { path: string }),
  write_file: (args) => handleWriteFile(args as { path: string; content: string }),
  edit_file: (args) => handleEditFile(args as { path: string; old_string: string; new_string: string }),
  bash: (args) => handleBash(args as { command: string; cwd?: string }),
  list_dir: (args) => handleListDir(args as { path: string }),
};

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "satellite",
  version: "1.0.0",
});

// Single tool: remote_exec
server.tool(
  "remote_exec",
  "Execute a tool on the remote server. You MUST call this tool with a tool name and arguments. The tool parameter selects which operation to perform: read_file, write_file, edit_file, bash, or list_dir. The args parameter passes arguments to that tool.",
  {
    tool: z.enum(["read_file", "write_file", "edit_file", "bash", "list_dir"]).describe("Tool name to execute"),
    args: z.record(z.any()).describe("Arguments to pass to the tool"),
  },
  async ({ tool, args }) => {
    const t0 = Date.now();

    // Validate args against tool schema before forwarding
    const schema = TOOL_SCHEMAS[tool];
    if (!schema) {
      return { content: textContent(`Unknown tool: ${tool}`), isError: true };
    }
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      log(`remote_exec ${tool} → validation error: ${errors}`);
      return { content: textContent(`Validation error: ${errors}`), isError: true };
    }

    // Execute the tool
    log(`remote_exec → ${tool} ${JSON.stringify(args).slice(0, 200)}`);
    const handler = TOOL_HANDLERS[tool];
    const result = await handler(parsed.data);
    log(`remote_exec → ${tool} ${Date.now() - t0}ms`);
    return result;
  }
);

// ============================================================================
// Start
// ============================================================================

log("MCP server starting (stdio)");
const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server ready");
