/**
 * Satellite MCP tool input schema (flat).
 *
 * This is the public schema advertised via `server.registerTool` and used for
 * MCP `tools/list` introspection. The MCP SDK's `normalizeObjectSchema`
 * recognizes `z.object` but discards `z.discriminatedUnion` and `z.union`, so
 * we expose a flat `z.object` with all sub-op fields at the root. Runtime
 * validation inside the handler is separate (it dispatches to per-tool
 * implementations keyed by the `tool` field).
 *
 * Kept in its own file so the personal-assistant client can import it for
 * e2e tests of the transfer_file hook (it must validate the post-hook
 * payload against THIS schema — duplicating it in a test would let the
 * real schema drift silently).
 */
import { z } from "zod/v3";

export const REMOTE_EXEC_INPUT_SCHEMA = z.object({
  tool: z.enum([
    "bash",
    "read",
    "write",
    "edit",
    "transfer_file",
  ]),
  command: z.string().optional(),
  timeout: z.number().optional(),
  cwd: z.string().optional(),
  path: z.string().optional().default("."),
  offset: z.number().optional(),
  limit: z.number().optional().default(500),
  content: z.string().optional(),
  edits: z.array(z.object({
    oldText: z.string(),
    newText: z.string(),
  })).optional(),
  pattern: z.string().optional(),
  glob: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  literal: z.boolean().optional(),
  context: z.number().optional(),
  direction: z.enum(["remote_to_local", "local_to_remote"]).optional(),
  local_path: z.string().optional(),
  remote_path: z.string().optional(),
}).passthrough();
