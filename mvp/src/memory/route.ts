/**
 * Owner-only memories route, as a testable function. `api/memories.ts` wires it to Mem0.
 *
 * Off unless the owner sets `NLT_MEMORY_ENABLED=1` (404, nothing touched). 401 without an owner session.
 * The owner comes only from the session (`deps.owner`), never from the request. Every Mem0 read and write
 * passes ASFDK checks; anything but an explicit allow stops the call (fail closed).
 *
 * Save flow: text 1–500 chars, bucket `owner` or `project`, body ≤ 64 KB. The source message (if given)
 * must exist in Neon, belong to the owner, and not be blocked or unavailable (requires NLT_HISTORY_ENABLED=1).
 * The text passes `validateInputLength`, `sanitizeInput` and `detectInjectionPatterns` from @neurolift-technologies/asfdk.
 * Stored in Mem0 verbatim, with no rewriting.
 *
 * Recall is handled by the runner, not this route. This route only stores, lists and deletes.
 */

import type { AgentRequest, AgentResponse } from "../agent/route.ts";
import type { Memory, MemoryBucket, MemoryInput, MemoryStore } from "./store.ts";
import { validateInputLength, sanitizeInput, detectInjectionPatterns } from "@neurolift-technologies/asfdk";

export interface MemoryRequest extends AgentRequest {
  query?: Record<string, string | string[] | undefined>;
}

export interface MemoryRouteDeps {
  env: {
    NLT_MEMORY_ENABLED?: string;
    NLT_HISTORY_ENABLED?: string;
    DATABASE_URL?: string;
  };
  /** The signed-in owner's Vercel `sub`, or undefined. */
  owner: (request: MemoryRequest) => string | undefined;
  createStore: () => MemoryStore;
  /** Checks a source message in Neon: returns { kind } or undefined when not found / not owned. */
  sourceMessage?: (messageId: string, owner: string) => Promise<{ kind: string } | undefined>;
  log: (line: string) => void;
  now?: () => number;
}

const MAX_TEXT = 500;
const MAX_BODY_BYTES = 64 * 1024;
const BUCKETS: ReadonlySet<MemoryBucket> = new Set<MemoryBucket>(["owner", "project"]);
const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^mem-\d+$/i;

export function memoryEnabled(env: { NLT_MEMORY_ENABLED?: string | undefined }): boolean {
  return env.NLT_MEMORY_ENABLED === "1";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const firstQuery = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Deterministic write checks from @neurolift-technologies/asfdk. Returns an error message or undefined. */
export function writeChecks(text: string): string | undefined {
  if (!validateInputLength(text)) return "Text is too long";
  const sanitized = sanitizeInput(text);
  if (!sanitized.clean) return sanitized.reason ?? "Text failed sanitization";
  const injection = detectInjectionPatterns(text);
  if (injection.detected) return "Text contains a blocked pattern";
  return undefined;
}

/** Recall checks on each hit before injection. A hit that fails is skipped. */
export function recallChecks(text: string): boolean {
  if (!text || text.length < 1) return false;
  if (!validateInputLength(text)) return false;
  const sanitized = sanitizeInput(text);
  if (!sanitized.clean) return false;
  const injection = detectInjectionPatterns(text);
  return !injection.detected;
}

export async function handleMemoryRequest(request: MemoryRequest, response: AgentResponse, deps: MemoryRouteDeps): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (!memoryEnabled(deps.env)) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const owner = deps.owner(request);
  if (!owner) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const id = firstQuery(request.query?.id);

  if (method === "POST") {
    handlePost(request, response, deps, owner, id);
    return;
  }

  if (method === "DELETE") {
    if (id === undefined || !MEMORY_ID.test(id)) {
      response.status(400).json({ error: "id must be a UUID or memory id" });
      return;
    }
    const store = deps.createStore();
    let removed: boolean;
    try {
      removed = await store.remove(owner, id);
    } catch {
      deps.log(JSON.stringify({ event: "memory_error", op: "delete" }));
      response.status(503).json({ error: "Memory unavailable" });
      return;
    }
    if (!removed) {
      response.status(404).json({ error: "Not found" });
      return;
    }
    response.status(200).json({ deleted: true });
    return;
  }

  // GET
  const store = deps.createStore();
  let all: Memory[];
  try {
    all = await store.list(owner);
  } catch {
    deps.log(JSON.stringify({ event: "memory_error", op: "list" }));
    response.status(503).json({ error: "Memory unavailable" });
    return;
  }
  if (id !== undefined) {
    const found = all.find((m) => m.id === id);
    if (!found) {
      response.status(404).json({ error: "Not found" });
      return;
    }
    response.status(200).json(found);
    return;
  }
  response.status(200).json({ memories: all });
}

async function handlePost(
  request: MemoryRequest,
  response: AgentResponse,
  deps: MemoryRouteDeps,
  owner: string,
  _id: string | undefined,
): Promise<void> {
  if (!isRecord(request.body)) {
    response.status(400).json({ error: "Body must be a JSON object" });
    return;
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(request.body), "utf8");
  } catch {
    response.status(400).json({ error: "Body must be JSON" });
    return;
  }
  if (size > MAX_BODY_BYTES) {
    response.status(400).json({ error: "Body is too large" });
    return;
  }

  const { text, bucket, sourceMessageId } = request.body as {
    text?: unknown;
    bucket?: unknown;
    sourceMessageId?: unknown;
  };
  if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
    response.status(400).json({ error: `text must be a string of 1 to ${MAX_TEXT} characters` });
    return;
  }
  if (typeof bucket !== "string" || !BUCKETS.has(bucket as MemoryBucket)) {
    response.status(400).json({ error: 'bucket must be "owner" or "project"' });
    return;
  }
  if (sourceMessageId !== undefined && typeof sourceMessageId !== "string") {
    response.status(400).json({ error: "sourceMessageId must be a string" });
    return;
  }

  const checkError = writeChecks(text);
  if (checkError) {
    response.status(400).json({ error: checkError });
    return;
  }

  if (sourceMessageId !== undefined) {
    if (deps.env.NLT_HISTORY_ENABLED !== "1" || !deps.env.DATABASE_URL || !deps.sourceMessage) {
      response.status(503).json({ error: "History unavailable" });
      return;
    }
    const checked = await deps.sourceMessage(sourceMessageId, owner);
    if (!checked) {
      response.status(404).json({ error: "Not found" });
      return;
    }
    if (checked.kind === "blocked" || checked.kind === "unavailable") {
      response.status(400).json({ error: "Source message cannot be remembered" });
      return;
    }
  }

  const store = deps.createStore();
  let result: { owned: boolean; id?: string };
  try {
    result = await store.save(owner, { text, bucket: bucket as MemoryBucket, sourceMessageId });
  } catch {
    deps.log(JSON.stringify({ event: "memory_error", op: "save" }));
    response.status(503).json({ error: "Memory unavailable" });
    return;
  }
  if (!result.owned) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  response.status(200).json({ saved: true, id: result.id });
}