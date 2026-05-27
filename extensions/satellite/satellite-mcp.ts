#!/usr/bin/env bun
/**
 * Satellite MCP Server
 *
 * An MCP server that exposes remote file and shell tools via stdio transport.
 * Deploy on the remote server and connect via SSH.
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
// CWD State (maintained across tool calls)
// ============================================================================

let bashCwd = "/";

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "satellite",
  version: "1.0.0",
});

// ============================================================================
// Tools
// ============================================================================

server.tool(
  "read_file",
  "Read the contents of a file at the specified path",
  { path: z.string().describe("Path to the file to read") },
  async ({ path }) => {
    const t0 = Date.now();
    try {
      const content = await readFile(path, "utf-8");
      log(`read_file ${path} → ok ${Date.now() - t0}ms (${content.length} bytes)`);
      return { content: [{ type: "text" as const, text: content }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`read_file ${path} → error ${Date.now() - t0}ms: ${msg}`);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "write_file",
  "Write content to a file, creating directories as needed",
  {
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write"),
  },
  async ({ path, content }) => {
    const t0 = Date.now();
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      log(`write_file ${path} → ok ${Date.now() - t0}ms (${content.length} bytes)`);
      return { content: [{ type: "text" as const, text: "OK" }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`write_file ${path} → error ${Date.now() - t0}ms: ${msg}`);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "edit_file",
  "Replace first occurrence of a string in a file",
  {
    path: z.string().describe("Path to the file to edit"),
    old_string: z.string().describe("String to find and replace"),
    new_string: z.string().describe("Replacement string"),
  },
  async ({ path, old_string, new_string }) => {
    const t0 = Date.now();
    try {
      const content = await readFile(path, "utf-8");
      if (!content.includes(old_string)) {
        log(`edit_file ${path} → error ${Date.now() - t0}ms: string not found`);
        return { content: [{ type: "text" as const, text: `Error: String not found: ${old_string}` }], isError: true };
      }
      const updated = content.replace(old_string, new_string);
      await writeFile(path, updated, "utf-8");
      log(`edit_file ${path} → ok ${Date.now() - t0}ms`);
      return { content: [{ type: "text" as const, text: "OK" }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`edit_file ${path} → error ${Date.now() - t0}ms: ${msg}`);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "bash",
  "Execute a shell command and return its output",
  {
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory (defaults to current)"),
  },
  async ({ command, cwd }) => {
    const workDir = cwd || bashCwd;
    const t0 = Date.now();
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
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
      if (command.includes("cd ")) {
        try {
          const testProc = Bun.spawn(["sh", "-c", `cd ${workDir} && ${command} && pwd`], { stdout: "pipe" });
          await testProc.exited;
          const newCwd = (await new Response(testProc.stdout).text()).trim();
          if (newCwd) bashCwd = newCwd;
        } catch { /* ignore */ }
      }

      const output = [];
      if (stdout) output.push(stdout);
      if (stderr) output.push(`stderr: ${stderr}`);
      if (exitCode !== 0) output.push(`exit code: ${exitCode}`);

      log(`bash "${command.slice(0, 80)}" → ${exitCode === 0 ? "ok" : "error"} ${duration}ms`);
      return { content: [{ type: "text" as const, text: output.join("\n") || "(no output)" }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`bash "${command.slice(0, 80)}" → error ${Date.now() - t0}ms: ${msg}`);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

server.tool(
  "list_dir",
  "List contents of a directory",
  { path: z.string().describe("Path to the directory to list") },
  async ({ path }) => {
    const t0 = Date.now();
    try {
      const dirEntries = await readdir(path, { withFileTypes: true });
      const entries: Array<{ name: string; type: string; size: number }> = [];
      for (const entry of dirEntries) {
        const fullPath = join(path, entry.name);
        const file = Bun.file(fullPath);
        entries.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size: file.size,
        });
      }
      log(`list_dir ${path} → ok ${Date.now() - t0}ms (${entries.length} entries)`);
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`list_dir ${path} → error ${Date.now() - t0}ms: ${msg}`);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// ============================================================================
// Start
// ============================================================================

log("MCP server starting (stdio)");
const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server ready");
