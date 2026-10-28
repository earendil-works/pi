
# Standing Behaviour {#routines lede="Routines, reconciling instead of notifying, and how two owners keep a rule between them without a shared transaction."}

Notes older than 30 days should go every hour. Inbox files should be imported as they arrive. Notes of an archived
session should become read-only. Each of these is behaviour that stands, not a call someone makes. Written as bare
`setInterval`s and event listeners, it would keep running old code after a reload and touch state from nowhere. Chord
has one declared form for it: the **routine**.

## Four kinds

```ts
self.routines.every("cleanup", HOUR, (ctx) => dropOlderThan(30 * DAY, ctx));   // due time survives reloads
self.routines.on(settings, async (value, ctx) => applyLimit(value, ctx));        // a readable or event source
self.routines.loop("import", async (ctx) => {                                     // runs until the object ends
  while (!ctx.signal.aborted) await importNext(ctx);
});
self.routines.custom("ticker", ({ signal, run }) => {                             // anything else
  const timer = setInterval(() => run(tick), 1000);
  return () => clearInterval(timer);                                              // cleanup undoes the setup
});
```

Routines start when the object goes live, stop when it ends, and restart with the new code on every reload of their
plugin. Each run gets its own `ctx`; errors are caught and reported, never uncaught. Routines are named (`on`
optionally by its source) so Chord recognizes them across reloads; that is how `every` keeps its due time.

## Serialized per routine

The new instance of a routine starts only after the old handler in flight has settled; only that routine waits, for at
most the routine handover timeout (10 s), after which it starts anyway and the stuck handler is reported.

The reason, as a trace: a supervisor routine reconciles pending worker restarts. The old handler is midway through
`restart(W1)` when the plugin reloads. Without serialization the new routine starts at once, sees W1 still pending, and
restarts it a second time.

## Reconcile, don't track

A routine **reconciles from the current value**: it makes the world match what it sees now. It writes no "in
progress" flags, and it starts a job for long work (chapter XI). A handler that only cares about the latest value
compares with the current value itself; there is no `overlap` option. Subscribing to the object's own documents is
gapless: every commit is seen.

No bare timers or callbacks that touch state outside routines, jobs or calls. That is what lets Chord stop all of an
object's behaviour when it ends or reloads.

## Rules between two owners

Every thing has exactly one owner, the smallest object it belongs to. Some rules span two: "notes of an archived
session are read-only" involves the catalog (which knows archiving) and `NoteStore` (which holds notes). Two tempting
designs are wrong:

- **A cross-owner transaction** (archive and lock the notes atomically) would make the catalog know every plugin and
  couple their storage.
- **A notification** (`catalog` calls `notes.archive(session)`) can be lost: the worker is not running, the link drops,
  the process crashes between the archive and the call.

The design's rule: **the owner of the dependent data enforces the rule** by reconciling from the other owner's state
with an idempotent routine.

```ts
// NoteStore: an archived session's notes are read-only
const flags = self.state(NoteFlags);                         // { archived: boolean }, NoteStore's own document
const catalog = self.get(Catalog, {});                       // the server's session list: another owner
self.routines.on(catalog.sessions, async (sessions, ctx) => {
  const archived = sessions[session]?.archived ?? false;
  if (flags.value.archived !== archived) await flags.change((d) => { d.archived = archived; }, ctx);
});
// add and remove refuse while flags.value.archived
```

After a crash the routine runs again with the current value. The catalog does not know the notes plugin exists. The
same pattern closes a forward of an archived session in the ports plugin, aborts a job whose grant was revoked
(chapter VII), and keeps any invariant between plugins.

## Reading without starting a worker

The session list in the sidebar shows each session's note count. Getting `NoteStore { S1 }` for every session would
start every worker. The answer is plain publishing between two objects of one plugin, no Chord mechanism: the worker
side reports a summary to a server-side object by a method call from a routine, and clients read the server object.

```ts
// notes/contract.ts
export const NoteCounts = remote("notes.counts", {
  version: 1, input: obj({}), placement: () => Server(),
  variants: {
    owner: { state: { counts: map(int()) } },
    worker: { methods: { report: method(obj({ session: str(), count: int() })) } },
  },
});

// notes/server.ts
const Counts = defineState("notes.counts", {
  schema: obj({ bySession: map(obj({ count: int(), incarnation: str() })) }),
  version: 1, initial: () => ({ bySession: {} }), persist: true,     // survives a server restart
  checkpointWhen: (_v, _o, info) => info.deltasSinceBase > 64,
});

host.serve(NoteCountStore, (_input, self) => {                        // local, lifetime "host"
  const counts = self.state(Counts);
  return {
    counts: self.derive("counts", [counts], ([c]) => mapValues(c.bySession, (e) => e.count)),
    report: ({ session, count, incarnation }, ctx) =>
      counts.change((d) => {
        const last = d.bySession[session];
        if (last && last.incarnation > incarnation) return;               // uuidv7: an older worker, ignore
        d.bySession[session] = { count, incarnation };
      }, ctx),
  };
}, { lifetime: "host" });

host.serve(NoteCounts, (_input, principal, self) => {
  const store = self.get(NoteCountStore, {});
  if (principal.kind === "worker") return {
    variant: "worker",
    report: ({ session, count }, ctx) => {
      if (session !== principal.session) throw forbidden();               // a worker reports only itself
      return store.report({ session, count, incarnation: ctx.incarnation }, ctx);
    },
  };
  return { variant: "owner", counts: store.counts };
});

// notes/worker.ts, inside NoteStore
const counts = self.get(NoteCounts, {});                                   // a reference to the server
self.routines.on(count, (n, ctx) => inVariant(counts, "worker") && counts.report({ session, count: n }, ctx));
```

The server object keeps the latest value per session (in a document if it must survive a server restart) and
**ignores reports from an older worker incarnation** (incarnations are uuidv7, so they order by start time). A worker that was replaced may still deliver a late report; the
fence is the caller's incarnation, which Chord stamps on every call from the link handshake (R20): `ctx.incarnation`,
next to `ctx.principal`, not part of the principal or its key, never sent as data, so it cannot be forged. Session
status, subagent lists, unread marks and artifact lists in p2 all follow this pattern. The store is local and has no
caller incarnation of its own, so the view passes it on as data.

:::review | Review: `ctx.incarnation` across a relay (Q13, open)
A worker's call to the server arrives directly, so `ctx.incarnation` is the worker's. But a call relayed through the
server (a tab's call to a worker) carries the server's incarnation on the worker's side, because the worker's
handshake is with the server. Review round 3 proposes that relays stamp the origin host's incarnation, as they stamp
the principal. Undecided; the pattern above only needs the direct case.
:::

:::note | Built so far
Routines are layer L8. The design treats `every` as one of four forms over one runner; review round 3 proposed cutting
to `on` and `loop` only (C4), not decided.
:::
