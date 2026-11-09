# Writing p2 plugin code: practices

Rules for anyone (person or agent) writing or reviewing code in `apps/p2` (and p3). Each rule has the mistake it
prevents, taken from real reviews (PR #11951 among them), and what to do instead. Read this before changing a plugin's
server, worker or contract; the Chord rules behind it are `packages/chord/docs/design.md` and the decision "App
authoring rules confirmed by the p2 audit" in `packages/chord/docs/decisions.md`.

## 1. Decide who owns each fact before you move it

Every piece of state has exactly one owner: the host and object that is the authority for it. Before moving a field
from the server to a session (or back), write down for each field who enforces it.

- **The host that enforces a fact owns it.** The server decides where a session runs (relocation fence, MCP placement,
  where terminals open, which ports a session may forward) and whether a worker may start (archive). Those facts are
  the server's, even if a copy also lives in the session.
- **Content belongs to the session.** A title, the model and thinking level, the transcript: the session's worker owns
  them and reports them.
- **A person's view belongs to the person.** Pinned, read marks, recent: per user, on the server, keyed by user id.

Mistake: making the session the authority for `cwd`, `env` and `archivedAt` and letting the catalog follow the
worker's report. A buggy worker, or a session store edited on disk, can then un-archive the session or change where
the server thinks it runs.

## 2. A report carries only what the reporter owns

A worker pushes what the server's index shows (`p2-notes.md`, "Rules this code follows"). The receiving method takes
exactly the fields the worker owns and nothing else; the server never overwrites a fact it enforces with a worker's
value.

```ts
// Wrong: the whole row follows the worker
describeSelf: async (description, ctx) => catalog.mirror({ id, description }, ctx),   // cwd, env, archivedAt included

// Right: the report's schema holds only the worker's fields
describeSelf: method(obj({ title: str(), titleEdited: bool(), model: ModelRefSchema, thinkingLevel: ThinkingLevelSchema, applied: int() })),
```

## 3. One writer per store: never open another host's store

A session's store is written by its worker, and only by its worker. The server never opens it (`withStoredSession`
and the like), not even "while the worker is held stopped".

When someone changes a session's data while its worker is not running, the server stores the change as **pending
state** in its own store, and the worker **follows** it:

1. The server writes a pending edit (session, change, revision). Views show it at once (overlay on the last report).
2. The worker holds a server view of its pending edits; when it runs (now, or at its next start) it applies them in
   one commit and reports with the highest revision it applied.
3. The server deletes pending edits up to that revision.

```ts
export const PendingEdits = remote("p2.session-pending-edits", {
	version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { state: { edits: arr(PendingEditSchema) } } },
});

// worker
self.on(pending.edits, async ({ value: edits }, ctx) => {
	if (edits.length === 0) return;
	const state = await applyEdits(harness().durable, edits, ctx);
	await sessions.describeSelf({ ...state, applied: edits.at(-1)!.revision }, ctx);
});
```

No worker start for a rename, no pause or fence for edits, it survives crashes (pending edits are persisted), and it
works for archived and synced sessions.

## 4. "Is the worker running?" in a write path means the design is wrong

```ts
// Wrong
if (workers.running().includes(id)) return (await ctx.get(SessionInfo, { session: id })).edit(change, ctx);
return withStoredSession(dataDir, id, (session) => editSessionInfo(session, change, seed, ctx), ctx);
```

Two paths for one write double the code to test and open races (the worker starts between the check and the write).
There is one path: the owner applies changes it follows (rule 3), or the caller holds the owner's object and Chord
starts the worker on demand.

## 5. Values are immutable once handed over: no copies

Chord and Durable values are immutable by convention once handed over. Durable's `snapshot()` returns an immutable,
structurally shared revision; a `tx.doc()` draft exists only inside its transaction (`packages/durable/docs/spec.md`
§3.3, §3.4). Never copy to "be safe", and never with `JSON.parse(JSON.stringify(x))`:

- It defends against nothing: nothing may mutate a snapshot, and drafts die with their transaction.
- It hides missing ownership: a defensive copy says nobody knows who owns the value; fix that instead.
- It lies about the type: `as T` after the round trip claims a `T`, but `undefined` fields vanish, a `Date` becomes a
  string, a `Map`/`Set` becomes `{}`, `NaN` becomes `null`, a `bigint` or a cycle throws.
- It costs on every call, usually on a hot path.

```ts
// Wrong: copy a snapshot, copy a draft out of a transaction
return copy(await read.snapshot(SessionInfoDoc, context));
return session.commit(async (tx) => { /* ... */ return copy(draft); }, context);

// Right: return the snapshot as is (typed Readonly); after a commit, read the committed revision
const state: Readonly<SessionInfoState> = await read.snapshot(SessionInfoDoc, context);
await session.commit(async (tx) => { /* change the draft */ }, context);
return session.snapshot(SessionInfoDoc, context);
```

## 6. Types say the truth: no casts, no sentinels

- No `as` to make a value fit a type. If TypeScript cannot see it, fix the type or the code; a cast is allowed only
  for a decided invariant TypeScript cannot express, with a comment saying which.
- No magic values for states: `createdAt === 0` meaning "not written yet" is a tagged union
  (`{ kind: "unwritten" } | { kind: "written"; info }`) or an absent document.

## 7. Know what wakes your code, and do the least per wake

Every routine, signal or listener runs on some trigger. Check how often that trigger fires before putting work behind
it.

Mistake: a report loop woken by every entry of the main conversation (to catch the first user message for the title)
that, on every wake, read the document, copied it, called the server with the whole row; the server rewrote the row
and ran `sessions.set(db.value.all())`, re-reading every catalog row and pushing the full session list to every open
page. One assistant message re-sent all sessions to every client.

- Filter the trigger to what you need: wake on your document's changes, not on every entry; stop watching entries once
  the session is titled.
- Report only when the reported data changed.
- On the server, update the one row; a list state member changes by that row (a keyed member, a table with a live
  query), never by re-reading and re-sending everything.

## 8. Errors are reported, never swallowed

- No `.catch(() => {})`. A failure either matters (let it reject: a routine that throws is reported and retried with
  backoff by Chord) or the code says in a comment why it does not.
- No `console.error` in plugin code: errors go through the host's error path (Chord's `onError`, the logs plugin).

## 9. One implementation per piece of logic

If the logic exists (the first user message as a title is search's), import it from where it lives, or move it to a
shared module both import. A second copy drifts.

## 10. Comments are claims: check them

A comment that says "the catalog ignores an unchanged report" when the code rewrites the row and re-pushes the list
every time is worse than no comment. Re-read every comment you wrote against the code before you open the PR.

## 11. The PR says what and why

The description states the problem, the decision or design it implements (link it), what changed for users and for
other plugins, and what you tested. "Reeee" is not a description. A change of who owns data (rule 1) needs its
ownership table in the description.

## 12. Test the hard paths

Happy paths are the least interesting tests. For a change like moving data between hosts, test: the worker starting
in the middle of an edit; an edit while the worker is stopped, then a crash before it starts; a report racing an edit;
how many reports and pushes one message causes (a cost test). Contract changes keep the released versions working
(`evolve` with `accepts`, `test/p2/contract-versions.test.ts`).
