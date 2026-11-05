/**
 * Pure helpers for saved chat history on the chat page. No DOM access; tested with node --test.
 * See docs/superpowers/specs/2026-11-05-chat-history-neon-design.md §4.
 */

/** The data notice shown while history is on (spec copy, verbatim). */
export const HISTORY_NOTICE =
  "Your conversations are saved to this project's Neon database until you delete them. Messages the safety check blocks are saved only as a 'blocked' marker, without their text.";

/** Shown for a stored blocked message, whose text is never kept. */
export const BLOCKED_PLACEHOLDER = "This message was blocked by the safety check.";

const STORED_KINDS = new Set(["normal", "blocked", "unavailable"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * History is on for this tab only after a 200 with a conversation list. Anything else (404 off, 401, 503, network
 * error, a malformed body) leaves the page as it is without history.
 *
 * @param {{ status?: number, body?: unknown, networkError?: boolean } | undefined} result
 */
export function interpretHistoryList(result) {
  if (!result || result.status !== 200 || !isRecord(result.body) || !Array.isArray(result.body.conversations)) {
    return { state: "off" };
  }
  const conversations = result.body.conversations
    .filter((c) => isRecord(c) && typeof c.id === "string" && typeof c.title === "string")
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }));
  return { state: "on", conversations };
}

/** A saved conversation and its messages, or undefined for anything but a well-formed 200. */
export function interpretConversation(result) {
  if (!result || result.status !== 200 || !isRecord(result.body)) return undefined;
  const { conversation, messages } = result.body;
  if (!isRecord(conversation) || typeof conversation.id !== "string" || !Array.isArray(messages)) return undefined;
  return {
    conversation,
    messages: messages.filter(
      (m) => isRecord(m) && typeof m.id === "string" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string",
    ),
  };
}

/** Server limits (src/history/route.ts), applied here so a save is never rejected for them. */
export const MAX_SAVE_BATCH = 20;
export const MAX_SAVED_TEXT = 20_000;
const MAX_TITLE_CHARS = 80;
export const TRUNCATED = "…(truncated)";

/** Cuts by characters (code points), so an emoji is never split, and drops any lone surrogate. */
function cutChars(text, max) {
  const chars = Array.from(String(text).toWellFormed());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

/** A sidebar title from the first prompt: at most `max` characters, plus "…" when cut. */
export function shortTitle(text, max) {
  const clean = String(text).toWellFormed();
  return Array.from(clean).length > max ? `${cutChars(clean, max)}…` : clean;
}

/** The title sent to the server: well formed, trimmed, 1 to 80 characters. */
export function saveTitle(title) {
  const cut = cutChars(String(title ?? "").trim(), MAX_TITLE_CHARS).trim();
  return cut.length > 0 ? cut : "Conversation";
}

/**
 * One finished exchange in stored form. Skips the page's own messages (kind "info") and any without an id. Page kinds
 * map to stored kinds ("allowed" and unknown kinds become "normal"). If any message of this exchange is blocked, every
 * message of it is stored as blocked with empty text, so the prompt that was stopped is never kept, not even in the
 * page's retry queue. Text is cut to the server's limit with a marker, and a time ahead of `now` becomes `now`.
 */
export function toStoredMessages(exchange, now = Date.now()) {
  const kept = exchange.filter((m) => isRecord(m) && typeof m.id === "string" && m.kind !== "info");
  const blocked = kept.some((m) => m.kind === "blocked");
  return kept.map((m) => {
    const kind = blocked ? "blocked" : STORED_KINDS.has(m.kind) ? m.kind : "normal";
    const raw = kind === "blocked" ? "" : String(m.text ?? "").toWellFormed();
    const text = raw.length > MAX_SAVED_TEXT ? `${raw.slice(0, MAX_SAVED_TEXT - TRUNCATED.length).toWellFormed()}${TRUNCATED}` : raw;
    const at = m.at instanceof Date ? m.at.getTime() : Date.parse(m.at ?? "");
    const out = {
      id: m.id,
      role: m.role === "user" ? "user" : "assistant",
      kind,
      text,
      createdAt: new Date(Number.isFinite(at) ? Math.min(at, now) : now).toISOString(),
    };
    if (typeof m.model === "string") out.model = m.model.slice(0, 200);
    return out;
  });
}

/**
 * Saves exchanges for each conversation, one request at a time per conversation. Messages wait in
 * `conversation.unsaved` until the server accepts them; a failed request keeps them for the next exchange, and a
 * rejected batch (400) is dropped so it cannot block later saves. Sets `conversation.saveState` ("saved"/"unsaved"),
 * `conversation.stored` once anything was accepted, and `conversation.saving` (the running chain).
 *
 * @param {(body: object) => Promise<{ status?: number }>} send
 */
export function createSaver(send) {
  async function flush(conversation) {
    while (conversation.unsaved.length > 0) {
      const batch = conversation.unsaved.slice(0, MAX_SAVE_BATCH);
      const result = await send({ conversation: { id: conversation.id, title: saveTitle(conversation.title) }, messages: batch });
      if (result?.status === 200 || result?.status === 400) {
        const sent = new Set(batch.map((m) => m.id));
        conversation.unsaved = conversation.unsaved.filter((m) => !sent.has(m.id));
        if (result.status === 200) conversation.stored = true;
        else conversation.dropped = true;
        continue;
      }
      break; // keep everything for the next exchange
    }
    conversation.saveState = conversation.unsaved.length === 0 && !conversation.dropped ? "saved" : "unsaved";
  }

  return {
    /** Queues an exchange and resolves when this conversation's saves have settled. Never rejects. */
    enqueue(conversation, exchange, now = Date.now()) {
      conversation.unsaved = mergePending(conversation.unsaved ?? [], toStoredMessages(exchange, now));
      conversation.saving = (conversation.saving ?? Promise.resolve()).then(() => flush(conversation)).catch(() => {
        conversation.saveState = "unsaved";
      });
      return conversation.saving;
    },
    /** Resolves once no save is running for this conversation. */
    idle(conversation) {
      return conversation.saving ?? Promise.resolve();
    },
  };
}

/** Messages still to save: `pending` then `next`, without repeating an id. */
export function mergePending(pending, next) {
  const seen = new Set();
  const out = [];
  for (const m of [...pending, ...next]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
