
# Sessions and Conversations {#p2-sessions lede="The session lifecycle, status without a worker, chat, shell commands, subagents and search, each mapped to an owner and the Chord parts it uses."}

This chapter builds the domains a person touches most: the session list and its operations, the conversation view
and composer, shell commands, chat mode, subagents, messages between sessions, search and unread marks. Each section
names the owner, the host, and the Chord parts it uses; code appears only where it shows something new.

## The session lifecycle

The catalog (chapter XVIII) owns the session records. Its operations, by the Chord part each needs:

| Operation | Owner and form | Notes |
| --- | --- | --- |
| create | `Catalog.create`, a method | absolute directory, `~` expanded, must be a directory; on an environment, resolved there through the envs plugin; refuses an unknown model; model and thinking default to the last used |
| rename, pin | methods on `Catalog` | title 1 to 120 characters, whitespace collapsed; an explicit title is never replaced automatically |
| automatic title | a routine on the search feed | the first user message, line breaks to spaces, 100 characters |
| agent rename | an agent tool on the worker calling `Catalog` | root conversation only |
| archive, restore | methods; revocation; reconciling routines | below |
| clone, fork, relocate | jobs on the catalog store | outlive the call, cancellable, one outcome |
| delete | a job; decision #18 | below |

### Archive and restore

Archiving must stop the worker whatever it is doing, end guest access, and close the session's port forwards, while
keeping its storage. The catalog does none of the plugin-specific parts:

:::steps | Archiving S1
+++ One write
`Catalog.archive({ id: "S1" })` sets `archived: true` in the session record, in one transaction.
+++ Revoke the session
The catalog calls `host.revoke({ session: "S1" })`. Every guest principal of S1 has `{ session: "S1" }` in its
`revokedBy`, so their objects end and their links close on the server and on the worker (chapter VII). New
connections are refused by `authenticate`, because grants of an archived session are void.
+++ Stop the worker
The supervisor reconciles from `catalog.sessions` with a routine: an archived session's worker is stopped, and
`authorize` refuses to start it again.
+++ Plugins reconcile
The ports plugin's routine on `catalog.sessions` closes forwards of archived sessions. The search plugin marks the
session's rows archived. If the server crashed between the write and these steps, the routines run again with the
current value at the next start: nothing is a notification that can be lost.
+++ Restore
`Catalog.restore` clears the flag. Grants are valid again, so guests reconnect and authenticate as before; forwards
stay closed.
:::

### Clone, fork, relocate

Each is work that outlives its call, can be cancelled and has one outcome, so each is a **job** (chapter XI) on the
catalog's local store, keyed by the owner's request id. They differ in what they pause:

- **Clone** copies the session's store, uploads, downloads and artifacts under a new id, with the source worker
  paused (refused while work runs) and title "(copy)"; directories `0700`, files `0600`, no links, no overwrite; a
  partial copy is removed on failure.
- **Fork** before a user message copies the active context as of the entry before it into a new session (title
  "(fork)"), with the message waiting in the new session's editor. It needs two workers: the source reads history,
  the new one is seeded empty. A failure archives the copy.
- **Relocate** (cwd, environment or both): refused while the session is busy (naming the running subagents) or when
  a subagent has its own cwd and the move crosses machines. The job fences the worker (new admissions wait), updates
  the record, and moves the running worker in place by updating `SessionLocation`: natives that follow the location
  switch with a generation (chapter IX), and conversations that follow the session's cwd are rewritten in one Durable
  commit before work resumes. After 60 s it restarts the worker instead; on failure it releases the fence.

:::review | Review: jobs as objects (#9)
The design defers whether a long relocation or a login is a record inside its owner (watched through `running`) or an
object of its own (`Relocation { id }`). The construction above uses records. Decide when login is ported
(`design.md` §15, §26).
:::

### Delete

p2 has no session delete. p3 needs one that removes the session everywhere: every document tagged with the session
(`store.retireByTag(SessionTag, id)`, chapter V), the worker's databases (the Durable store), the session's files, the
search rows, read marks, children copies, forwards, guest records, and finally the catalog entry. The design commits to
this outcome (`design.md` §25); how plugins take part is open.

:::review | Review: session delete (#18)
Options in `design.md` §26: per-session objects plus `SessionTag` plus one session directory (delete is retire by tag
and remove a directory, plugins need do nothing), or owner hooks contributed through a catalog registry. Also open:
whether the search index is per session (deleted with it) or global with a hook. Who holds the store for
`retireByTag` is not specified either.
:::

## Status, children, unread: reports to the server

The session list must show status, subagents and unread marks for sessions whose workers are not running, and must
not start them. All three follow chapter X's pub/sub pattern: a routine on the worker calls a server object with the
current summary, the server object keeps the latest value per session (persisted where it must survive a restart),
ignores calls from an older `ctx.incarnation`, and clients read the server object.

| Summary | Source on the worker | Kept on the server |
| --- | --- | --- |
| status: running, error, task count, busy conversations, usage and cost | the harness's task graph and usage | `SessionStatus`, in memory: a stopped worker is "not running" |
| children: name, model, thinking, tools, cwd, last entry, archived | the subagents plugin's child list | `Children`, persisted |
| latest root answer | the search feed | `Unread`: compared with the owner's read mark, persisted, shared by all owner devices |

Guests see their own session's status without the error text. The owner's read mark is written when the root
conversation is visible, and a new session starts as read.

## Conversations

The harness (chapter XIV) owns the Durable store. The UI needs, per conversation: a live window of entries, older
pages, usage numbers, the working indicator, the inbox (queued inputs), and the actions. Two core objects provide them:

- **`ConversationStore { conversation }`** (local, on the worker): opens the Durable watch as its native, reaching
  the harness through the core-private `HarnessRuntime` registry entry, and exposes a **window** as a derive: the
  newest entries (at most 100 or 512 KiB, at least 20) plus the conversation's documents. The window's start stays
  put while it is within 1.5 times the limits, so new entries arrive as small appends instead of a shifted list
  (chapter VIII's window pattern).
- **`Conversation { session, conversation }`** (remote, placement `Session`): the per-principal view. Variants by
  `can()`: `owner` (everything, including model, thinking and handoff), `writer` (guest write: send, steer, stop,
  compact, shell), `reader` (the window only).

```ts
host.serve(Conversation, ({ session, conversation }, principal, self) => {
  const store = self.get(ConversationStore, { conversation });
  const policy = self.get(ConversationPolicy, { conversation });         // core: readOnly, followsSessionCwd
  const author = authorOf(principal);                                    // structured: kind, id, display name
  if (!can(principal, "send", session)) return { variant: "reader", view: store.window, page: store.page };
  return {
    variant: can(principal, "manage") ? "owner" : "writer",
    view: store.window,
    page: store.page,                                                    // older history: returns data
    send: ({ text, attachments, mode, requestId }, ctx) => {
      if (policy.value.readOnly) throw forbidden("read-only conversation");
      return store.submit({ type: "input", content: text, attachments, author, whenBusy: mode, requestId }, ctx);
    },
    stop: (_args, ctx) => store.stop(author, ctx),                       // allowed even when read-only
    …
  };
});
```

What each function becomes:

| Function | How |
| --- | --- |
| send, retried send | Durable `submit` with the author's `requestId`: a retry with the same id is admitted once (Durable dedupes, chapter XIV) |
| steer or queue while busy | `whenBusy: "steer"` or a follow-up; the inbox is `docs["pi.inbox"]` in the window |
| attribution | the view derives the author from the principal; the entry stores it structured, the model sees a speaker block; nothing parses text |
| wait for prompt resources | the first input of a fresh worker waits until the prompt plugin's resources are loaded (a registry readable the store follows) |
| stop, dequeue | withdraw queued inputs, abort the run; the caller's texts return to its editor, other authors' to their **restored drafts** |
| restored drafts | a keyed document per (conversation, author), tagged `SessionTag`, persisted in the store; claimed once, first tab wins |
| read-only conversations | the core per-conversation policy document, written at `createConversation({ init })` by whoever creates the conversation; send, dequeue, configure, compact and shell refuse; stop is allowed |
| history pages | a method returning a page (100 entries, 1 MB, 2,000 scanned); compaction and reset markers always included |
| model and thinking | owner variant only; validated against the models plugin's catalog; the root conversation's model is also reported as the session default |
| compaction, handoff | Durable operations through the store |

**Drafts in the composer** are UI state, not Chord state: the web shell keeps one draft in `sessionStorage`, the TUI
keeps one per conversation across UI replacements, and pending sends keep their request id until acknowledged
("Sending when connected"). Only restored drafts, which the worker produces, are documents.

## Shell commands

`!cmd` runs a command in the conversation's cwd on its environment and records the result as an entry; `!!cmd` does
the same but keeps the output out of the model's context. One command at a time per conversation; the live tail is
at most 50 KB or 2,000 lines, sampled every 200 ms; the full output spills to a file; the result entry is placed at the
run's next boundary while the agent is busy and never starts a run. This is the design's job example almost as is:

```ts
const ShellJob = defineJob("chat.shell", {
  version: 1,
  args: obj({ command: str({ max: 100_000 }), include: bool(), author: Author }),
  progress: obj({ output: str() }),
  result: ShellResult,
  concurrency: 1,                                                   // one per conversation
});

const results = self.state(ShellResults);                           // keyed by run id: dedupe after completion
const shell = self.job(ShellJob, {
  run: async ({ command, include, author }, ctx) => {
    const out = new OutputBuffer({ maxBytes: 50_000, maxLines: 2000, retain: "tail" });
    const env = await environmentFor(ctx);                          // the conversation's environment, chapter XX
    const r = await env.exec(command, { cwd: env.cwd, signal: ctx.signal, spill: spillPath(ctx.jobId) },
      (chunk) => { out.push(chunk); ctx.progress({ output: out.snapshot().text }); });
    const data = { command, output: out.snapshot().text, exit: r.code, cancelled: ctx.signal.aborted };
    await conversation.submit(
      { type: "write", entry: shellEntry(data, author, include), requestId: `shell:${ctx.jobId}` }, ctx);
    return data;
  },
  finish: async (done, tx) => {
    (await tx.draft(results, done.id)).outcome = done.kind === "done" ? done.result : { error: done.error };
  },
});
```

The request id `shell:${ctx.jobId}` makes the entry idempotent: an attempt interrupted after the write cannot write
it twice. Cancel is `shell.abort(id)`, allowed for the command's author and the owner. A retried `runShell` with the
same request id returns the running job (dedupe of unsettled runs), or the stored result (the owner's own dedupe after
completion, chapter XI). p2's "cancel when nobody watched for 30 s" is dropped: a job keeps its owner alive and does
not depend on viewers.

## Chat mode

Chat mode is a per-conversation switch that everyone in the session sees and only the owner changes; forks and new
subagents start with it off. Because it must fork and rewind with the conversation, it is **transcript-bound**: a
Durable conversation document, not a Chord document. Messages without `@pi` become display-only Durable `write`
entries (author, text, attachments, reply quote); a message with `@pi` becomes an input with a digest of the chat
since the last mention (at most 100 messages, 20 files, 4 images), recording which entries it passed on. The reply
quote is derived on the worker from the entry id the client names: the client never supplies author or quote text.

## Subagents and one-shot agents

Subagents are Durable child conversations owned by tasks, as in Durable's own background-subagent example: one
`subagent` tool spawns, steers, waits for, stops and lists them; each child is owned by a background anchor task, and
each message is delivered by a reporter task that posts the answer back to the parent once, with request ids so a
restart sends nothing twice. Chord adds only three things:

- the **child list** for the sidebar is reported to the server (`Children`, above), so it shows without a worker;
- a child that follows the session's cwd, or a read-only one-shot agent created by a code-mode script, is marked in
  the core **per-conversation policy document** when it is created, so chat and relocation enforce it without knowing
  the subagents plugin (`design.md` §25 porting guideline);
- archive and restore of a child from the UI are methods on the subagents plugin's view, refused for one-shots.

Subagents cannot spawn subagents; thinking levels are clamped to what the model supports, in one helper shared with
the session's model choice.

## Messages between sessions

The root agent can list other sessions and send one an attributed message. The tool runs on the sender's worker and
calls a server object through `chord(fn, context)` (chapter XIV):

```ts
const peerSend = defineTool({
  name: "session_send",
  execute: (args, api, context) => chord(async (ctx) => {
    const peers = await ctx.get(Peers, {});                       // server, worker variant
    await peers.send({ to: args.session, text: args.text, mode: args.mode, requestId: `peer:${api.taskId}` }, ctx);
    return { output: [{ type: "text", text: "sent" }] };
  }, context),
});
```

`Peers` checks that the sender is a root conversation of a non-archived session, refuses sending to itself and
archived recipients, then gets the recipient's `Conversation` (which starts its worker) and submits with the
sender as a structured author and the same request id (the tool task's id, stable across restarts), so a retried
tool call delivers once. The sender's
incarnation is `ctx.incarnation`; a call from a replaced worker is refused. Only owner-initiated turns may use the
tool; guests never.

## Search

The search plugin indexes user and assistant messages of root and subagent conversations (no shell output, no
Durable internal inputs) for title, cwd and message search across sessions, active or archived.

:::flow wide animate | The search feed. The worker pushes pages from a cursor; the server owns the index and never starts a worker to answer a query.
row "Worker S1" blue
box commit "Durable commit" "in any conversation"
box wake "wake" "a routine on the harness's commit signal"
box page "read from cursor" "200 entries per page"
row "Server" accent
box index "SearchIndex" "native: SQLite FTS" accent
box cursor "cursor per conversation" "moves after the whole range"
box query "query" "terms, scope, at most 41 hits"
arrow commit -> wake
arrow wake -> page
arrow page -> index "report(page)"
arrow index -> cursor
note "Reports carry ctx.incarnation. Indexing is idempotent: a page sent twice changes nothing."
:::

The index is a native owned by a host-lifetime object on the server; cursors live with the index, so after a crash
the worker asks for the cursor and continues. Rebuilding one session's index drops its rows and rescans, starting
an archived session's worker without resuming its work. Queries are methods returning data: at most 41 hits,
snippets of 300 characters, queries up to 500 characters. The same feed sets automatic titles, moves "updated at"
forward and supplies the latest root answer for unread marks.

## Presence

Viewers per session are `host.references(Conversation)` on the worker, counted per client (chapter VIII), and
reported with the status. Connected guests (name and mode) are the references whose principal is a guest. Presence
is not keep-alive: the supervisor uses `host.activity`, which also counts calls and jobs.

:::note | Built so far
None of this exists in p3. The parts it relies on are Durable (built: submit with request ids, steer and queue,
child conversations, background tasks) and the Chord layers L3 to L9 (not built).
:::
