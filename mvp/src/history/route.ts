/**
 * Owner-only chat history route, as a testable function. `api/conversations.ts` wires it to Neon.
 *
 * Off unless the owner sets `NLT_HISTORY_ENABLED=1` (404, nothing touched). 401 without an owner session. The owner
 * comes only from the session (`deps.owner`), never from the request. A message of kind `blocked` is stored with
 * empty text. A store failure logs only the operation name and answers 503. See
 * docs/superpowers/specs/2026-11-05-chat-history-neon-design.md §3.
 */
import type { AgentRequest, AgentResponse } from "../agent/route.ts";
import type { HistoryStore, MessageKind, MessageRole, SaveInput, StoredMessage } from "./store.ts";

export interface HistoryRequest extends AgentRequest {
  query?: Record<string, string | string[] | undefined>;
}

export interface HistoryRouteDeps {
  env: { NLT_HISTORY_ENABLED?: string; DATABASE_URL?: string };
  /** The signed-in owner's Vercel `sub`, or undefined. */
  owner: (request: HistoryRequest) => string | undefined;
  createStore: (databaseUrl: string) => HistoryStore;
  log: (line: string) => void;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES: ReadonlySet<string> = new Set<MessageRole>(["user", "assistant"]);
const KINDS: ReadonlySet<string> = new Set<MessageKind>(["normal", "blocked", "unavailable"]);
const MAX_TITLE = 80;
const MAX_MESSAGES = 20;
const MAX_TEXT = 20_000;
const MAX_MODEL = 200;
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 524_288;
const UNAVAILABLE = { error: "History unavailable" } as const;

export function historyEnabled(env: { NLT_HISTORY_ENABLED?: string | undefined }): boolean {
  return env.NLT_HISTORY_ENABLED === "1";
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validates a save body. A `blocked` message always gets empty text. */
export function parseSaveBody(body: unknown, now: number): SaveInput | { error: string } {
  if (!isRecord(body)) return { error: "Body must be a JSON object" };
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(body), "utf8");
  } catch {
    return { error: "Body must be JSON" };
  }
  if (size > MAX_BODY_BYTES) return { error: "Body is too large" };

  const conversation = body.conversation;
  if (!isRecord(conversation) || typeof conversation.id !== "string" || !UUID.test(conversation.id)) {
    return { error: "conversation.id must be a UUID" };
  }
  const title = typeof conversation.title === "string" ? conversation.title.trim() : "";
  if (title.length < 1 || title.length > MAX_TITLE) return { error: `conversation.title must be 1 to ${MAX_TITLE} characters` };

  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_MESSAGES) return { error: `messages must hold 1 to ${MAX_MESSAGES} items` };
  const messages: StoredMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { error: "Each message must be an object" };
    if (typeof item.id !== "string" || !UUID.test(item.id)) return { error: "message.id must be a UUID" };
    if (typeof item.role !== "string" || !ROLES.has(item.role)) return { error: "message.role is not allowed" };
    if (typeof item.kind !== "string" || !KINDS.has(item.kind)) return { error: "message.kind is not allowed" };
    if (typeof item.text !== "string" || item.text.length > MAX_TEXT) return { error: `message.text must be a string of at most ${MAX_TEXT} characters` };
    if (item.model !== undefined && item.model !== null && (typeof item.model !== "string" || item.model.length > MAX_MODEL)) {
      return { error: `message.model must be at most ${MAX_MODEL} characters` };
    }
    const at = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
    if (!Number.isFinite(at) || at > now + MAX_FUTURE_MS) return { error: "message.createdAt must be an ISO time, not in the future" };
    const kind = item.kind as MessageKind;
    messages.push({
      id: item.id,
      role: item.role as MessageRole,
      kind,
      // A message the safety check blocked is kept only as a marker.
      text: kind === "blocked" ? "" : item.text,
      model: typeof item.model === "string" ? item.model : null,
      createdAt: new Date(at).toISOString(),
    });
  }
  return { conversation: { id: conversation.id, title }, messages };
}

const firstQuery = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export async function handleHistoryRequest(request: HistoryRequest, response: AgentResponse, deps: HistoryRouteDeps): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (!historyEnabled(deps.env)) {
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
  const databaseUrl = deps.env.DATABASE_URL;
  if (!databaseUrl) {
    response.status(503).json(UNAVAILABLE);
    return;
  }

  // Validate before touching the store.
  const id = firstQuery(request.query?.id);
  let save: SaveInput | undefined;
  if (method === "POST") {
    const parsed = parseSaveBody(request.body, (deps.now ?? Date.now)());
    if ("error" in parsed) {
      response.status(400).json({ error: parsed.error });
      return;
    }
    save = parsed;
  } else if ((method === "DELETE" || id !== undefined) && (id === undefined || !UUID.test(id))) {
    response.status(400).json({ error: "id must be a UUID" });
    return;
  }

  const op = method === "POST" ? "save" : method === "DELETE" ? "delete" : id !== undefined ? "get" : "list";
  try {
    const store = deps.createStore(databaseUrl);
    if (save) {
      const result = await store.save(owner, save);
      if (!result.owned) response.status(404).json({ error: "Not found" });
      else response.status(200).json({ saved: result.saved });
    } else if (op === "delete") {
      if (await store.remove(owner, id as string)) response.status(200).json({ deleted: true });
      else response.status(404).json({ error: "Not found" });
    } else if (op === "get") {
      const found = await store.get(owner, id as string);
      if (found) response.status(200).json(found);
      else response.status(404).json({ error: "Not found" });
    } else {
      response.status(200).json({ conversations: await store.list(owner) });
    }
  } catch {
    // Only the operation name: never the error message, SQL, text or connection string.
    deps.log(JSON.stringify({ event: "history_error", op }));
    response.status(503).json(UNAVAILABLE);
  }
}
