# Chat history in Neon — design

**Date:** 2026-11-05
**Owner:** Joshua W. Dorsey, Sr.
**Status:** design approved in conversation; awaiting review of this written spec
**Scope:** `mvp/` (NLT Coding Agent MVP on Vercel, project `nlt-pi-mvp`)

## 1. Intent

The owner added Neon (Postgres) to the Vercel project and wants chat history saved there.

- **Outcome:** conversations survive a reload, a closed tab and a change of device. The owner can reopen and delete them.
- **For whom:** the signed-in owner only (Sign in with Vercel; allow-list `NLT_OWNER_VERCEL_SUBS`).
- **Success:** on any device, after signing in, the sidebar lists past conversations; opening one shows its messages; deleting one removes it from Neon and the sidebar.

### Decisions (owner, 2026-11-05)

| Question | Decision |
|---|---|
| What Neon is for first | Chat history. Mem0 waits. |
| Does the agent see earlier messages? | No. Save and show only; each turn stays independent. Agent context can be a later change. |
| Retention | Kept until the owner deletes a conversation; nothing expires. |
| Messages blocked by the ASFDK gate | Saved as a placeholder only: role, kind `blocked` and time, never the text. |
| Who writes | The page (approach A). `/api/agent` and `/api/govern` are unchanged. |

### Out of scope

- Mem0 (see "Planned next phase" below), Neon Auth, Neon realtime.
- Giving the model conversation context.
- Search, export, renaming conversations, or editing past messages.
- Use by anyone but the owner.

### Planned next phase: Mem0 as the memory layer (owner, 2026-11-05)

The owner's direction is for Mem0 to be the agent's intelligent memory layer. Neon stays the exact transcript, for the owner to reopen and delete. Mem0 would hold distilled, long-lived facts and preferences that the agent recalls across conversations. That changes how the agent runs: it would no longer answer each message on its own, and conversation text would go to Mem0, a further third-party processor. So it gets its own design and spec once chat history ships. This design keeps the two apart: nothing here writes to Mem0, and nothing here depends on it.

## 2. Data model

Created on first use with `CREATE TABLE IF NOT EXISTS`, run once per process before the first query.

```sql
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          uuid PRIMARY KEY,
  owner_sub   text NOT NULL,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_conversations_owner_updated
  ON chat_conversations (owner_sub, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id               uuid PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  kind             text NOT NULL CHECK (kind IN ('normal', 'blocked', 'unavailable')),
  text             text NOT NULL,
  model            text,
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_created
  ON chat_messages (conversation_id, created_at);
```

- Ids are UUIDs generated on the page (`crypto.randomUUID()`). Saving is idempotent: a retried save with the same message id does nothing a second time (`ON CONFLICT (id) DO NOTHING`).
- `owner_sub` is the `sub` from the signed session cookie (`sessionFromCookie`). It never comes from the request body.
- A `blocked` message is stored with `text = ''`, whatever the page sends.

## 3. Server

### Switch

`NLT_HISTORY_ENABLED=1`, owner-set per Vercel environment. Anything else means the endpoint answers 404 and touches nothing, and the page behaves exactly as it does today. The database URL is `DATABASE_URL`, the pooled connection set by the Neon integration. If `DATABASE_URL` is missing while the switch is on, the endpoint answers 503.

### Endpoint `api/conversations.ts`

The logic lives in `src/history/route.ts` and is testable without a server, like `src/agent/route.ts`. Rules, in order:
- 404 when the switch is off.
- 401 without an owner session.
- `Cache-Control: no-store` on every answer.

| Method | Query or body | Answer |
|---|---|---|
| `GET` | none | `200 { conversations: [{ id, title, createdAt, updatedAt }] }`: the owner's conversations, newest `updatedAt` first, at most 100 |
| `GET` | `?id=<uuid>` | `200 { conversation: { id, title, createdAt, updatedAt }, messages: [{ id, role, kind, text, model, createdAt }] }`, or 404 if it is not the owner's |
| `POST` | `{ conversation: { id, title }, messages: [{ id, role, kind, text, model?, createdAt }] }` | Upserts the conversation (owner-checked; the title is updated), inserts the messages (skipping ids already saved), and sets `updated_at`. Answers `200 { saved: n }`. If the id belongs to another owner, 404. |
| `DELETE` | `?id=<uuid>` | Deletes the owner's conversation and, by cascade, its messages. `200 { deleted: true }`, or 404 if it is not the owner's |
| anything else | | 405 with an `Allow` header |

### Validation (anything invalid is a 400 with a short message, and nothing is written)

- **Ids:** canonical UUID strings.
- **Title:** a string, trimmed, 1–80 characters.
- **Messages per save:** 1–20. `role` and `kind` must be one of the allowed values.
- **Text:** a string of at most 20,000 characters (forced to empty for `blocked`).
- **`model`:** an optional string of at most 200 characters.
- **`createdAt`:** an ISO time no more than 5 minutes in the future.
- **Body:** at most 512 KB.

### Data access `src/history/store.ts`

A narrow interface with list, get, save and delete. Every statement:
- uses parameters, never string-built SQL;
- includes `owner_sub = $owner` (directly, or through a join on the conversation);
- runs inside the endpoint's request, never at module load.

The real implementation uses `@neondatabase/serverless` (exact version pinned). Tests use an in-memory fake that has the same interface and keeps owners apart.

### Errors and logging

- A database error is logged as one line, `{"event":"history_error","op":"<list|get|save|delete>"}`. It carries no message text, no SQL and no connection string. The endpoint answers `503 { error: "History unavailable" }`.
- Successful calls are not logged.

## 4. Page

`public/app.js`, plus small pure helpers in `public/lib/history.js` so they can be tested with `node --test`.

- **Detection:** after `loadSession()` reports signed in, the page calls `GET /api/conversations`. A 200 turns history on for this tab. Any other answer (404 off, 401, 503, a network error) leaves the page exactly as today.
- **Load:** the sidebar's "Recent sessions" lists the saved conversations. Choosing one calls `GET ?id=` and renders its messages using the existing `appendMessage` (with `textContent`). A conversation loaded this way has no streaming state.
- **Save:** after each exchange finishes (the user message plus its reply or failure note), the page posts them. Blocked messages are sent as `kind: "blocked"`; the server drops their text anyway. A failed save keeps the messages in a per-conversation pending queue, and they are retried with the next save or the next exchange. Nothing is lost while the tab stays open.
- **Status:** a small per-conversation marker in the sidebar, "Saved" or "Not saved".
- **Delete:** a delete button on each conversation. After `confirm("Delete this conversation?")` the page calls `DELETE`, and removes the conversation from the sidebar only on a 200.
- **Notice (`index.html`):** the static text stays as it is for when history is off. When history turns on, the page replaces that sentence with: "Your conversations are saved to this project's Neon database until you delete them. Messages the safety check blocks are saved only as a 'blocked' marker, without their text." The free-model reminder is unchanged. The header comment in `app.js` ("save anything") is updated.

## 5. Dependency

`@neondatabase/serverless`, pinned to an exact version, added to `mvp/package.json`. Before it is added, `npm audit` is run and `check:pinned-deps` and `check:runtime-deps` must pass. If the current version pulls in a flagged dependency, the newest clean version is used, as was done for `@vercel/sandbox`.

## 6. Testing

Offline only: Vitest for the server and `node --test` for the page helpers. No test reaches the real Neon database.

**Route:**
- 404 when off, with the store never created;
- 401 without a session;
- 405 with an `Allow` header;
- each 400 rule;
- the owner taken from the session, never from the body;
- another owner's id gives 404 on GET, POST and DELETE;
- a blocked message stored with empty text;
- a retried save does not duplicate;
- a store error gives a 503 whose log line has no text, SQL or URL;
- a missing `DATABASE_URL` while on gives a 503.

**Store:**
- the real store's SQL is parameterised and includes the owner filter, checked against the statements a stubbed driver records;
- the schema is created once per process.

**Page helpers:**
- reading each server answer (on, off, error);
- building a save body (blocked text dropped, limits applied);
- merging the pending queue;
- choosing the notice text.

**Mutation checks:** removing the owner filter, or the blocked-text drop, makes a test fail.

**Not verified offline:** a real Neon connection, and the schema actually being created on Neon. The owner checks this once by setting `NLT_HISTORY_ENABLED=1` and reloading the page.

## 7. Governance and records

- An intent record goes under `docs/agent-log/` before implementation, because this is a new persistence boundary.
- Update the README (the history section and the switch), `docs/active-threads.md`, and a handoff record.
- The PR follows `PULL_REQUEST_TEMPLATE.md`.
- `NLT_HISTORY_ENABLED` is set only by the owner, or at the owner's explicit request.
