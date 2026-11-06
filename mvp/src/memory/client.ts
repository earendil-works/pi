/**
 * Mem0 HTTP client, server side only.
 *
 * Talks to the Mem0 REST API over `fetch`. The API key and base URL come from
 * environment variables and are never passed to the browser or the sandbox.
 *
 * Endpoints used (all under MEM0_BASE_URL, default https://api.mem0.ai):
 *   POST /v1/memories/        create one memory (infer=false: verbatim, no rewriting)
 *   GET  /v1/memories/?...    list/search by user and agent
 *   GET  /v1/memories/{id}    get one memory by id (for ownership verification on delete)
 *   DELETE /v1/memories/{id}  delete one memory (owner-verified by caller)
 *
 * Each memory stores:
 *   user_id   = the owner's session `sub` (server-side only)
 *   agent_id  = `nlt-pi-mvp`
 *   content   = the verbatim memory text (infer=false: no rewriting)
 *   metadata  = { bucket, repo: "nlt-pi", source_message_id, created_at }
 */

const AGENT_ID = "nlt-pi-mvp";
const REPO = "nlt-pi";
const DEFAULT_BASE_URL = "https://api.mem0.ai";

export type MemoryBucket = "owner" | "project";

export interface Memory {
  id: string;
  text: string;
  bucket: MemoryBucket;
  createdAt: string;
  sourceMessageId?: string;
  /** Optional metadata kind (e.g. "toi" for TOI uploads). TOI uploads are excluded from normal listing/recall. */
  kind?: string;
}

export interface MemoryClientEnv {
  MEM0_API_KEY?: string;
  MEM0_ORG_ID?: string;
  MEM0_PROJECT_ID?: string;
  MEM0_BASE_URL?: string;
}

export interface MemoryClient {
  /** Create one memory. Returns the Mem0 id, or undefined on failure. */
  create(owner: string, input: {
    text: string;
    bucket: MemoryBucket;
    sourceMessageId?: string;
    /** Optional metadata override. Callers must include bucket/repo/source_message_id if needed. */
    metadata?: Record<string, unknown>;
  }): Promise<string | undefined>;
  /** List the owner's memories for this agent. */
  list(owner: string): Promise<Memory[]>;
  /** Get one memory by id. Returns undefined when not found or not the owner's. */
  get(owner: string, id: string): Promise<Memory | undefined>;
  /** Delete one memory by id. False when not found or not the owner's. */
  remove(owner: string, id: string): Promise<boolean>;
  /** Search memories for the owner and agent, up to `limit` results. */
  search(owner: string, query: string, limit: number): Promise<Memory[]>;
}

function baseUrl(env: MemoryClientEnv): string {
  return env.MEM0_BASE_URL ?? DEFAULT_BASE_URL;
}

function authHeaders(env: MemoryClientEnv): HeadersInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.MEM0_API_KEY ?? ""}`,
    "content-type": "application/json",
  };
  if (env.MEM0_ORG_ID) headers["x-mem0-organization-id"] = env.MEM0_ORG_ID;
  if (env.MEM0_PROJECT_ID) headers["x-mem0-project-id"] = env.MEM0_PROJECT_ID;
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMemory(item: Record<string, unknown>): Memory | undefined {
  const id = typeof item.id === "string" ? item.id : undefined;
  const text = typeof item.memory === "string" ? item.memory : typeof item.text === "string" ? item.text : undefined;
  if (!id || !text) return undefined;
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  const bucket = metadata.bucket === "owner" || metadata.bucket === "project" ? (metadata.bucket as MemoryBucket) : "owner";
  const createdAt = typeof item.created_at === "string" ? item.created_at : typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString();
  const sourceMessageId = typeof metadata.source_message_id === "string" ? metadata.source_message_id : undefined;
  const kind = typeof metadata.kind === "string" ? metadata.kind : undefined;
  return { id, text, bucket, createdAt, sourceMessageId, kind };
}

function toArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (isRecord(value)) {
    for (const key of ["results", "memories", "data"]) {
      if (Array.isArray(value[key])) return value[key] as Record<string, unknown>[];
    }
  }
  return [];
}

export function createMemoryClient(env: MemoryClientEnv): MemoryClient {
  const configured = () => typeof env.MEM0_API_KEY === "string" && env.MEM0_API_KEY.length > 0;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!configured()) throw new Error("Mem0 not configured");
    const url = `${baseUrl(env)}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: { ...authHeaders(env), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!response.ok) throw new Error(`Mem0 ${init.method ?? "GET"} ${path}: ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) return response.json();
    return response.text();
  }

  /** Fetch one memory by id; returns undefined when not found or not owned. */
  async function get(owner: string, id: string): Promise<Memory | undefined> {
    try {
      const result = await request(`/v1/memories/${encodeURIComponent(id)}`);
      const record = isRecord(result) ? result : {};
      const mem = toMemory(record);
      if (!mem) return undefined;
      // Confirm the memory belongs to the requesting owner.
      if (mem.text === undefined || record.user_id !== owner) return undefined;
      return mem;
    } catch {
      return undefined;
    }
  }

  return {
    async create(owner, input) {
      try {
        const body = {
          user_id: owner,
          agent_id: AGENT_ID,
          content: input.text,
          infer: false,
          metadata: {
            bucket: input.bucket,
            repo: REPO,
            source_message_id: input.sourceMessageId ?? null,
            created_at: new Date().toISOString(),
            ...(input.metadata ?? {}),
          },
        };
        const result = await request("/v1/memories/", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const record = isRecord(result) ? result : {};
        const id = typeof record.id === "string" ? record.id : typeof record.memory_id === "string" ? record.memory_id : undefined;
        return id;
      } catch {
        return undefined;
      }
    },

    async list(owner) {
      try {
        const result = await request(
          `/v1/memories/?user_id=${encodeURIComponent(owner)}&agent_id=${encodeURIComponent(AGENT_ID)}`,
        );
        const records = toArray(result);
        return records.map(toMemory).filter(Boolean) as Memory[];
      } catch {
        return [];
      }
    },

    async remove(owner, id) {
      try {
        // Verify ownership before deleting: Mem0's DELETE endpoint may not
        // enforce owner scoping, so we confirm the memory belongs to `owner`
        // first. Never delete another owner's memory.
        const existing = await get(owner, id);
        if (!existing) return false;
        await request(`/v1/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
        return true;
      } catch {
        return false;
      }
    },

    async search(owner, query, limit) {
      try {
        const result = await request("/v1/memories/search/", {
          method: "POST",
          body: JSON.stringify({
            user_id: owner,
            agent_id: AGENT_ID,
            query,
            limit,
          }),
        });
        const records = toArray(result);
        return records.map(toMemory).filter(Boolean) as Memory[];
      } catch {
        return [];
      }
    },
    async get(owner, id) {
      return get(owner, id);
    },
  };
}