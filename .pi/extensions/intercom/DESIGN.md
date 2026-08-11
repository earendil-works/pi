# Intercom Extension — v1 Design

## What this is

Live session-to-session messaging for pi sessions running in the same project
directory. Two (or more) sessions join a named channel and exchange messages like
humans in a chat: a question asked by one wakes the other, which answers, which wakes
the first. No sockets, no server, no daemon — the transport is one JSON file per
message under `<cwd>/.pi/intercom/<channel>/`, and delivery is a poll loop.

Two driving use cases (Kyle, 2026-08-11):

1. **Handoff Q&A.** Session B starts from a handoff note (see the sibling `handoff`
   extension) and has clarifying questions. If session A is still open, B asks on a
   channel and A answers before B commits to a direction. (When A is already gone,
   the handoff extension's `ask_predecessor` tool answers from A's transcript
   instead — the two features deliberately compose.)
2. **Co-op playtesting.** Two sessions test a two-player game (Constellation: one
   drives the laptop view, one the phone view), coordinating in real time
   ("casting Freeze Stars — go"), then report back.

## Why polling, not push

Agents don't need millisecond latency; they need reliable ordered delivery with zero
infrastructure. A 1.5 s poll interval is indistinguishable from instant next to an
LLM turn, and files-on-disk means the whole system is debuggable with `ls` and `cat`.
pi's `pi-server` package was considered and rejected for v1: it is explicitly
experimental ("may change or be removed without notice"), and this extension should
not couple to it.

## Storage layout

```
<cwd>/.pi/intercom/
  <channel>/                                  one directory per channel
    2026-08-11T10-00-00-000Z_019feda9_0000.json   one file per message
```

- Filename = sanitized ISO timestamp + first 8 chars of sender session id + per-process
  sequence. Lexicographic order = delivery order, so a reader's entire resume state is
  one string: the last filename it has seen (the *cursor*).
- One file per message (atomic `.tmp` + rename) means concurrent writers can never
  interleave bytes; there is nothing to lock.
- Message = JSON: `schema` (`pi-intercom/v1`), `channel`, `sender` (full session id),
  optional `alias`, `created` (ISO), `text`. Files failing validation are skipped and
  left in place; the cursor still moves past them.
- `.git/info/exclude` gets `**/.pi/intercom/` appended (same mechanism, and the same
  reasoning, as the handoff extension's `notes.ts` — see the comment there). The
  git-exclude helper is *duplicated*, not imported: extensions are self-contained
  units, and importing across `.pi/extensions/` siblings would couple this
  extension's load to the other's presence.

## Delivery semantics

- **Joining** a channel (via `/intercom join`, or automatically by using either tool
  on it) starts the cursor at `undefined` = the full existing backlog is delivered.
  This is deliberate: a question sent *before* its answerer joined must still arrive.
  Channels are project-local and short-lived; `/intercom clear` resets one between
  runs.
- **Own messages are never delivered back** (filtered by `sender`), but they do
  advance the cursor.
- **The watcher** (one `setInterval`, 1.5 s, `unref()`ed so it can never hold pi's
  exit open) scans every joined channel and injects anything new via
  `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`: an idle session
  wakes up and responds; a busy one sees the message before its next LLM call.
- **`intercom_wait`** marks its channel `waiting`, which keeps the watcher out of the
  way — otherwise one message could be delivered twice (once as the tool result, once
  as an injected memo). The tool and the watcher share the same per-channel cursor.
- Watcher failures never throw (an interval callback that throws takes down the
  process); the last error is kept and surfaced by `/intercom status`.

## Surface

Tools (LLM):
- `intercom_send { channel, message, alias? }` — write one message; auto-joins.
- `intercom_wait { channel, timeout_seconds? }` — block (default 60 s, max 300 s)
  until a message arrives, the signal aborts, or the timeout passes; auto-joins.
  Waiting costs no tokens, which matters on free-tier models.

Commands (user):
- `/intercom join <channel> [as <alias>]` · `/intercom leave <channel>` ·
  `/intercom clear <channel>` · `/intercom status`

Renderer: `customType: "intercom"` messages get the same boxed, accent-banner
treatment as handoff memos, so injected traffic is visually distinct from the user's
own prompts.

## Known limits (accepted for v1)

- **Same machine, same project cwd.** The mailbox is a directory; sessions on
  different machines or in different checkouts don't see each other.
- **`/reload` drops joined channels** (extension state is in-process). Rejoin by hand
  or via a tool call.
- **Messages accumulate** until `/intercom clear`. No TTL, no size cap: v1 traffic is
  small, human-supervised, and visible on disk.
- **No addressing beyond channels.** Everyone on a channel sees everything; two-party
  use is by convention (one channel per pair). Fine at this scale.

## Verification

- `store.ts` and `format.ts` have no pi imports and are covered by unit tests
  (round-trip, cursor semantics, corrupt-file skip, clear, git-exclude idempotence,
  rendered text).
- `index.ts` (tool/command/watcher wiring) is exercised interactively; it contains no
  logic beyond wiring that isn't already under test. Same trade the handoff
  extension's DESIGN.md documents for its `index.ts`.
- CI: `.github/workflows/intercom-ext.yml`, a sibling of `handoff-ext.yml`, runs the
  unit tests and a typecheck against pi source on every push/PR to main.
