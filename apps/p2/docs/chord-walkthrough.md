# Chord and p2: a guided walkthrough

A step-by-step introduction to how p2 plugins work on top of Chord, for someone who knows nothing about either. It
describes the design (`target-design.md`), not the state of the implementation.

---

## For the agent guiding the user

You walk a user through this document. Follow these rules:

1. **One concept at a time.** Explain it in your own words, in the user's language, with the example from the
   document. Don't paste the whole section; keep it short and concrete.
2. **Then ask the check questions** of that concept (2–3) and **wait** for the answers.
3. **Judge the answers** against the model answers (they are for you, not for the user). If an answer is wrong or
   half right, say precisely what is missing, explain that part again differently, and ask again. Don't move on while
   a concept is not understood.
4. **Counter-questions come first.** If the user asks something, answer it completely before anything else. If the
   answer lies in a later concept, say so, give a short answer, and offer to continue there.
5. **Move on only when the user says so.**
6. **No terms before they are introduced.** If you need one, introduce it first.
7. **Teach the design, not the implementation status.** Don't say what exists today and what is planned. When a
   question goes beyond this document, answer from these sources, in this order: `target-design.md` (the design;
   it wins on conflicts), `changes.md` (the reasoning behind each change), `packages/chord/docs/tutorial/` (Chord's
   tutorial: plugin files, the app's API, how an app loads plugins), `packages/chord/docs/design.md` (Chord's API and
   links). The code lives in `packages/chord` and
   `apps/p2`; it may lag behind the design.
8. Keep a short list of what the user found hard, and come back to it at the end.

Start by telling the user the note below, then begin with concept 1.

## For the user

**Keep asking until you really understand a thing.** There are no silly questions. The concepts build on each other:
a gap early on makes everything after it harder. If an example doesn't click, ask for another one. If a word is
unclear, ask what it means.

---

## The setting and the running example

**p2** is a coding-agent app built from plugins. It runs as several processes. Chord calls each process a **host**, and
every backend host has a name:

- the **server** (name `server`): exactly one; serves the web UI, holds data shared by all sessions, starts the
  workers;
- a **worker** per session (name `session:S1` for session S1): runs the agent and works on the session's files;
- **clients**: browsers (the web UI) and TUIs (a terminal UI), any number.

**How they connect:**

```
browser ──┐  WebSocket          IPC  ┌── worker session:S1
browser ──┼───────────── server ─────┤
TUI ──────┘                          └── worker session:S2
```

- Each connection is a **link**. Clients connect only to the server, over a WebSocket. The server starts a worker as a
  child process when its session is first needed and talks to it over IPC (the pipe between a parent process and its
  child).
- Clients never talk to a worker directly; the server **relays**. A browser call to something in session S1 travels
  browser → server → worker `session:S1`, and the answer comes back the same way. Workers reach each other through the
  server too.
- When a client connects, the server checks who it is (its cookie) and remembers that for the whole link. Concept 2
  builds on this.

**Chord** is the runtime under p2: it lets plugins define **objects** that live on one host and lets any host use them
across links.

**The goal that shapes everything: reload.** You change a plugin's code, and the new code takes over inside the
running app. No host restarts: the server, the workers and the browsers keep running, and so do open terminals,
running scripts, the agent's current answer and connected browsers. Only the changed plugin's code is swapped. This is
a **reload**; the opposite is a **restart**, where a process ends and starts again and everything it held in memory is
lost.

Much of what follows exists to make reloads safe: what must survive a reload (data, open files), what must be replaced
(behaviour), and how running work is handed over. Concept 11 shows how a reload works step by step; until then it is
enough to know: **on a reload, the plugin's factories run again with the new code, in the same running process.**

**A plugin** is a folder under `plugins/`. Each file is meant for certain hosts:

| File | Runs on | Holds |
| --- | --- | --- |
| `contract.ts` | every host that imports it | descriptions only: names, shapes, method signatures |
| `server.ts` | the server | code for the server |
| `worker.ts` | every session worker | code that needs the agent or the session's files |
| `web.tsx` | the browser | UI components |
| `tui.ts` | the TUI | terminal UI |

The running example is a **notes** plugin:

- notes per session, stored in SQLite;
- a text file dropped into an inbox folder becomes a note;
- notes older than 30 days are deleted every hour;
- a web panel shows the notes; the owner and invited guests with write access can add notes, read-only guests can only
  read.

---

## Concept 1: Object types and objects

**The problem.** Several places need "the notes of session S1": the owner's browser tab, a guest's tab, an HTTP export
handler. If each built its own copy, they would drift apart, and nobody would know when to clean up.

**The idea.** There is **one object** "notes of S1". Everyone asks Chord for it by its **address** and gets the same
one.

- An **object type** describes what such an object is: its name, what its address looks like (the **input**), on
  which host it lives, and what you can do with it (its **members**: data you can read and methods you can call). It
  contains no code that runs; it is a description every host can share. Another word for it is **contract**.
- A **factory** is the code that builds an object of that type, on the host where it lives.
- An **object** is one concrete instance: "Notes for `{ session: "S1" }`".

The three pieces live in three files of the notes plugin:

```ts
// plugins/notes/contract.ts: the object type, imported by the worker and the browser
export const Notes = remote("notes", {               // a type usable across links, named "notes"
  version: 1,                                        // the contract's version (concept 12)
  host: sessionHost,                                 // lives on the worker "session:" + input.session
  input: Type.Object({ session: Type.String() }),    // the address: { session: "S1" } (a TypeBox schema)
  variants: { /* the members, concept 2 */ },
});
```

```ts
// plugins/notes/worker.ts: the factory, runs on every session worker
export default defineFacet((host) => {               // runs when the plugin loads; host = this worker (concept 7)
  host.serve(Notes, (input, principal, self) => {    // "this host builds Notes objects like this"
    // input = { session: "S1" }; principal: concept 2; self: concept 3
    return { /* members */ };
  });
});
```

```ts
// plugins/notes/web.tsx: a caller, in the browser
const notes = await host.get(Notes, { session: "S1" });   // browser → server → worker session:S1
```

- **Where an object lives** is decided by the type alone. p2 defines two placements (`src/runtime/chord.ts`):
  - `sessionHost = hostFamily("session:", "session")`: the host name is the prefix `"session:"` plus the input's
    `session` field. For `{ session: "S1" }` that is `session:S1`. The input must have that field;
  - `serverHost = hostNamed("server")`: always the host `server`.

  The caller only names the type and the input; Chord computes the host and sends the request there through the
  server.
- **Who builds it:** the host where it lives runs the factory. That is why the factory is in `worker.ts`: `server.ts`
  could not serve `Notes`, and Chord refuses that at startup.
- **One object per address:** the first time anyone asks for `{ session: "S1" }`, Chord runs the factory. Everyone who
  asks later for the same address gets the same object (concept 2 refines this). `{ session: "S2" }` is another object, on another worker.
- **`local` and `remote`:** a `local(...)` type can only be used on its own host; a `remote(...)` type can also be used
  from other hosts across links (here: the browser using an object on the worker).

**Check questions**

1. Two tabs ask for the notes of S1. How many objects exist, and how often did the factory run?
2. What is the difference between `Notes` and "Notes for S1"?
3. Where does the object for S2 live, and who decides that?

*Model answers:* (1) one object, the factory ran once (same address; concept 2 refines this when the callers are
different people). (2) `Notes` is the description (type); "Notes for S1" is one instance (object). (3) In the worker of
session S2; the type's `host` declaration decides, derived from the input.

---

## Concept 2: Who is calling (principals and variants)

**The problem.** The owner may do everything; a read-only guest may only read; a guest of another session may do
nothing. The object must know who calls, and the caller must not be able to lie.

**The idea.** Every call carries a **principal**, the caller's identity. It is never taken from the message: the link
stamps it, from what the server learned when the client connected (its cookie, see the setting). When the server
relays a call to a worker, it passes the principal along; a worker accepts a passed-along principal only from its
parent link, the server. So nothing a client sends, at any hop, changes who it is.

p2's principals, each with a `kind`:

| `kind` | Who |
| --- | --- |
| `owner` | the person running p2 |
| `guest` | someone invited into one session: `{ kind: "guest", session: "S1", mode: "view" \| "full", … }` |
| `worker` | a session worker calling the server |
| `server` | the server calling a worker |
| `host` | a host's own code calling an object on the same host |

The factory gets the principal and decides what the caller gets. An object type can have **variants**: named sets of
members. The factory returns one of them, named by `variant`.

```ts
// plugins/notes/contract.ts: the variants of Notes
variants: {
  reader: { state: { notes: NotesSchema } },                                     // can read the notes
  editor: { state: { notes: NotesSchema }, methods: { add: method(AddArgs) } },  // can also add one
}
```

```ts
// plugins/notes/worker.ts: the factory picks the variant per caller
host.serve(Notes, ({ session }, principal, self) => {
  if (!canView(principal, session)) throw forbidden();      // refuse: the caller gets an error, no object
  const notes = loadNotes(session);                         // simplified; see the problem below
  if (!canSend(principal, session)) return { variant: "reader", notes };
  return { variant: "editor", notes, add: (args, ctx) => addNote(session, args, ctx) };
});
```

`canView` and `canSend` are p2 helpers (`src/runtime/principals.ts`):

- `canView`: the owner, or a guest of this session;
- `canSend`: the owner, or a guest of this session with `mode: "full"`.

- **A reader has no `add` at all.** Chord refuses calls to members that are not in the caller's variant, so `add` needs
  no check of its own.
- **The caller sees which variant it got.** A reference is typed as one of the variants, told apart by `variant`.
  TypeScript lets you use `add` only after checking `notes.variant === "editor"`; at runtime, using a member of another
  variant throws `not_in_variant`:

  ```ts
  // plugins/notes/web.tsx: a caller
  const notes = await host.get(Notes, { session: "S1" });
  notes.add({ text: "hi" });            // type error: `add` exists only on the editor variant
  if (notes.variant === "editor") {
    await notes.add({ text: "hi" });    // fine: narrowed to editor
  }
  ```
- **One object per (type, input, caller).** The factory builds something different per caller, so each caller gets its
  own object. Concept 1's "one object per address" holds per caller: two tabs of the owner share one `Notes`; two guests
  get one each.

**The problem this creates.** If each caller has its own `Notes`, and the notes were loaded inside it, there would be
one copy per caller again: exactly what concept 1 wanted to avoid.

**Store plus view.** The data goes into a second object type that everyone shares, and the per-caller object only checks
and forwards:

```ts
// plugins/notes/worker.ts: a local type, defined where it is used
const NoteStore = local("notes.store", {
  input: Type.Object({ session: Type.String() }),
  members: { notes: …, add: method(AddArgs) },
});
host.serve(NoteStore, ({ session }, principal, self) => ({ /* loads and holds the notes of one session */ }));

host.serve(Notes, ({ session }, principal, self) => {
  if (!canView(principal, session)) throw forbidden();
  const store = self.get(NoteStore, { session });           // get another object from inside a factory (concept 3)
  if (!canSend(principal, session)) return { variant: "reader", notes: store.notes };
  return { variant: "editor", notes: store.notes, add: (args, ctx) => store.add(args, ctx) };
});
```

- `NoteStore` is `local`: only code on this worker can get it, so no browser ever reaches it directly.
- Every `Notes` factory asks for it with the same principal, `host` (this worker's own code), so there is one
  `NoteStore` per session, shared by all `Notes` objects of that session.
- This "store plus view" pattern is everywhere in p2.


**Check questions**

1. A read-only guest calls `add`. What happens, and where is it decided?
2. Could a malicious browser claim to be the owner? Why not?
3. The owner has a tab open, two guests are in S1. How many `Notes` and how many `NoteStore` objects exist?

*Model answers:* (1) The guest got the `reader` variant (the factory decided), which has no `add`; Chord refuses the
call. (2) No: the link stamps the principal from the server's authentication of the connection, never from a message;
when relayed, the worker accepts it only from the server. (3) Three `Notes` (owner, guest A, guest B; a second owner tab
would share the owner's), one `NoteStore` (every `Notes` gets it as `host`).

---

## Concept 3: References

**The problem.** When can an object be cleaned up? Not while someone uses it, but not never either.

**The idea.** Asking for an object gives you a **reference**, not the object. While at least one reference exists, the
object lives. When the last one is released, Chord cleans it up (and the object releases the references it holds
itself).

There are three ways to get a reference; they differ in when it is released:

| Where you are | How | Released when |
| --- | --- | --- |
| in a factory | `self.get(Type, input)` | the object holding it ends |
| in a method | `await ctx.get(Type, input)` | that call ends |
| outside Chord (startup code, UI) | `await host.get(Type, input)` | you call `ref.release()` |

`ctx` is the context every method call gets as its last argument (concept 10); here it only matters that `ctx.get`
binds a reference to one call.

**Which one:** ask how long the object needs the other object.

```ts
// plugins/notes/worker.ts
host.serve(Notes, ({ session }, principal, self) => {
  const store = self.get(NoteStore, { session });         // needed for the object's whole life: factory, self.get
  return {
    variant: "editor",
    notes: store.notes,
    add: async (args, ctx) => {
      const filter = await ctx.get(SpamFilter, {});       // needed for this call only: method, ctx.get
      if (await filter.check(args.text, ctx)) await store.add(args, ctx);
    },
  };
});
```

`self.get` belongs in the factory only: it declares what the object keeps. Called in a method, it would take another
long-lived reference on every call.

**A trace:**

1. The owner opens the notes panel; the browser calls `host.get(Notes, { session: "S1" })`. The worker builds the
   owner's `Notes`; its factory's `self.get` builds `NoteStore`. Chain: browser → owner's `Notes` → `NoteStore`.
2. A guest joins and gets their own `Notes`, which references the same `NoteStore`.
3. The owner closes the tab. The browser's reference is released, the owner's `Notes` ends and releases its reference
   to `NoteStore`. The guest's `Notes` still holds it: the store stays.
4. The guest closes too. The guest's `Notes` ends, `NoteStore` has no reference left and ends.

A lost link counts as closing: when a link dies, everything held through it is released.

**More rules:**

- **A reference you hold is usable:** the object is live and its data is there, whether it lives on this host or
  another one.
- `self.get` in a factory is synchronous: it only declares. Chord makes the object live after the objects it references
  are ready.
- `host.serve(Type, factory, { linger: 30_000 })` keeps an unreferenced object 30 seconds longer: closing and reopening
  the panel quickly rebuilds nothing.
- `host.serve(Type, factory, { lifetime: "host" })` makes the object live as long as its host, referenced or not. It is
  created when the plugin loads, not at the first `get`. Such a type is `local` and has no required input, so there is
  exactly one per host (each worker has its own). For services every plugin needs.

**Check questions**

1. The owner closes the tab; a guest still has it open. Does `NoteStore` end? And when the guest closes too?
2. `Notes.add` checks every note against `SpamFilter`. (a) `add` is rare and the filter is expensive to keep alive;
   (b) every `Notes` uses the filter constantly. Where and how do you get the reference in each case?
3. What does `lifetime: "host"` change?

*Model answers:* (1) No, the guest's `Notes` still references it; when the guest closes too, it ends (after `linger`
if set). (2) (a) `ctx.get` in `add`: alive only while a call needs it; (b) `self.get` in the factory: alive as long as
the `Notes`, no call waits for it to start. `self.get` never goes into a method. (3) The object exists from loading
until its host stops, independent of references; one per host.

---

## Concept 4: State

**Where we are.** The notes plugin so far:

```ts
// plugins/notes/contract.ts
export const NoteSchema = Type.Object({ id: Type.Number(), text: Type.String() });
export const NotesSchema = Type.Array(NoteSchema);
export const AddArgs = Type.Object({ text: Type.String() });

export const Notes = remote("notes", {
  version: 1,
  host: sessionHost,
  input: Type.Object({ session: Type.String() }),
  variants: {
    reader: { state: { notes: NotesSchema } },
    editor: { state: { notes: NotesSchema }, methods: { add: method(AddArgs) } },
  },
});
```

```ts
// plugins/notes/worker.ts
const NoteStore = local("notes.store", { input: Type.Object({ session: Type.String() }), members: { /* notes, add */ } });

export default defineFacet((host) => {
  host.serve(NoteStore, ({ session }, principal, self) => ({ /* holds the notes: this concept */ }));

  host.serve(Notes, ({ session }, principal, self) => {
    if (!canView(principal, session)) throw forbidden();
    const store = self.get(NoteStore, { session });
    if (!canSend(principal, session)) return { variant: "reader", notes: store.notes };
    return { variant: "editor", notes: store.notes, add: (args, ctx) => store.add(args, ctx) };
  });
});
```

Two things are missing: what `notes` is inside `NoteStore`, and how a browser shows it and stays current.

**The problem.** The notes change: someone adds one. Every open panel, on any host, should show the change at once. A
plain variable can't do that:

- nobody is told when it changes;
- it can't travel over a link;
- the factory runs again on every reload (see the setting), so a variable created there starts empty again.

**The idea.** **State** is a named, observable value with a schema (a **cell**). The object that declares it owns it and
is the only one that writes it. Anyone holding a reference to the object can read it and is told when it changes, on
any host.

### Declaring and writing (the owning object)

For now the notes live only in memory:

```ts
// plugins/notes/worker.ts
host.serve(NoteStore, ({ session }, principal, self) => {
  const notes = self.state("notes", NotesSchema, { init: () => [] });   // name, schema, first value

  return {
    notes,                                              // returned: holders of a reference can read and watch it
    add: async ({ text }, ctx) => {
      const id = (notes.value.at(-1)?.id ?? 0) + 1;
      notes.change(ctx, (draft) => {
        draft.push({ id, text });
      });
    },
  };
});
```

- `self.state(name, schema, { init })` declares the cell. `init` gives its first value, here an empty list; it runs
  before the object goes live. (Concept 5 loads the first value from a database instead.)
- **Writing:** `notes.change(ctx, (draft) => …)` edits a draft: atomic (all or nothing if the callback throws), and only
  the paths you touch change. `notes.replace(ctx, value)` sets the whole value.
- **Every write needs a `ctx`**, so writes happen only inside calls. The factory gets no `ctx`: it only declares.
- `notes.value` is immutable: never mutate what you read.
- What the factory returns is visible to holders of a reference; a cell it doesn't return is private.

### Passing state on (the view)

`Notes` returns `notes: store.notes`: the store's cell becomes a member of every `Notes` object. It is not a copy: all
`Notes` of S1 show the same value, with no code to keep them in sync.

### Reading and watching (the consumers)

Every state member of a reference has `.value` (the current value) and `.subscribe(fn)` (called on every change; returns
a function that stops it). An awaited reference already has the first value.

Without UI (any host, a script, a test):

```ts
const notes = await host.get(Notes, { session: "S1" });
notes.notes.value;                                         // [{ id: 1, text: "buy milk" }]
const stop = notes.notes.subscribe((list) => console.log(list.length));
// …
stop();
notes.release();
```

In the browser, p2's React hooks (`src/runtime/web.tsx`) do the same for a component:

```tsx
// plugins/notes/web.tsx
function NotesPanel({ session }: { session: string }) {
  const notes = useObject(Notes, { session });   // host.get while mounted, release on unmount
  const list = useReadable(notes?.notes);        // the current value; re-renders on every change
  if (!notes || !list) return <p>Loading…</p>;
  return (
    <section>
      <ul>{list.map((note) => <li key={note.id}>{note.text}</li>)}</ul>
      {notes.variant === "editor" && (            // TypeScript knows: `add` exists only for editors
        <button onClick={() => void notes.add({ text: "hi" })}>Add</button>
      )}
    </section>
  );
}
```

Inside an object, reacting to state (for example, writing a file whenever the notes change) is not a `subscribe` in the
factory but an effect (concept 6).

### One add, step by step

The owner and a full guest both have the panel open. The guest clicks Add:

1. The guest's browser calls `notes.add({ text: "hi" })`. The server relays it to worker `session:S1`, to the guest's
   `Notes` (variant `editor`), which forwards to `store.add`.
2. `store.add` appends the note with `notes.change`.
3. Chord sends the **change** (the one new element, not the whole list) to every host holding a reference with that
   member: the owner's browser and the guest's browser, both through the server.
4. In each browser `useReadable` re-renders the panel.

A new reference gets the whole value once, then only changes; after a reconnect or a reload it gets the whole value
again. The call's result and the state change travel separately: when `await notes.add(…)` returns, the panel may not
show the note yet. Wait for the state, not for the call.

### Derived data

```ts
const count = self.derive([notes], (list) => list.length);
return { notes, count, add };
```

A derivation is computed from other state and recomputed when it changes. Nobody writes it, and it needs no name: after
a reload it is simply computed again.

### Why cells have names

On a reload the factory runs again; `self.state("notes", …)` then returns the **existing** cell with its current value,
and `init` does not run again. So the notes survive a reload. They do not survive a **restart** (the process ends): the cell lives in
memory. Concept 5 fixes that.

If the schema or meaning of a cell changes, you raise its `version`; concept 5 shows what then happens.

**Check questions**

1. Why can't the factory write state?
2. You reload the notes plugin, then later the worker process restarts. What happens to the notes each time?
3. A guest should see only the number of notes. What do you change, and on which objects?
4. The owner and a guest have the panel open; the guest adds a note. What reaches the owner's browser, and how?

*Model answers:* (1) The factory only declares and has no `ctx`; it runs again on every reload (first as a trial), so a
write there would overwrite the surviving value or happen in a discarded trial. (2) Reload: kept, the named cell is
returned with its value. Restart: gone, the cell was only in memory. (3) `NoteStore` derives `count` and returns it;
`Notes` gets a variant with only `count` (for example `counter: { state: { count: Type.Number() } }`) and returns
`count: store.count` for such guests. (4) Only the change to `notes` (the new note), sent from the worker through the
server; `useReadable` re-renders. No call and no full list.

---

## Concept 5: Resources

**Where we are.** `NoteStore` keeps the notes in a cell (concept 4):

```ts
// plugins/notes/worker.ts
host.serve(NoteStore, ({ session }, principal, self) => {
  const notes = self.state("notes", NotesSchema, { init: () => [] });
  return {
    notes,
    add: async ({ text }, ctx) => {
      const id = (notes.value.at(-1)?.id ?? 0) + 1;
      notes.change(ctx, (draft) => { draft.push({ id, text }); });
    },
  };
});
```

**The problem.** A cell lives in memory: when the worker restarts, the notes are gone. They must be stored in a file,
here SQLite. But where do you open the file?

```ts
// wrong
host.serve(NoteStore, ({ session }, principal, self) => {
  const db = openDb(notesPath(session));   // runs on every reload: a new handle each time, the old ones never closed
  // …
});
```

The factory runs again on every reload. Each run would open another file handle, and nothing ever closes them, not
even when the object ends.

**The idea.** A **resource** is a native thing the object opens once and closes once: a database handle, a socket, an
SSH connection, a sandbox. It is declared by name, like a cell, and survives reloads.

```ts
const db = self.resource("db", { version: 1 },
  () => openDb(notesPath(session)),    // open: runs once, before the object goes live
  (db) => db.close());                 // close: runs once, when the object ends
db.value;                              // the open handle (in methods)
```

**The store, now persistent:**

```ts
// plugins/notes/worker.ts
host.serve(NoteStore, ({ session }, principal, self) => {
  const db = self.resource("db", { version: 1 }, () => openDb(notesPath(session)), (db) => db.close());
  const notes = self.state("notes", NotesSchema, {
    version: 2,                                         // was: 1 (the default); see "Reloading into this version"
    migrate: (old) => old,                              // see "Reloading into this version"
    init: async ({ previous }) => {                     // was: () => []
      if (previous) db.value.insertMissing(previous);   // only on the reload from concept 4
      return db.value.all();
    },
  });

  return {
    notes,
    add: async ({ text }, ctx) => {
      const id = db.value.insert(text);                                   // 1. the truth: SQLite
      notes.change(ctx, (draft) => { draft.push({ id, text }); });        // 2. the live copy
    },
  };
});
```

What changed:

- `db` is a resource: opened before the object goes live, closed when it ends.
- `init` no longer returns `[]` but loads the notes from SQLite **before** the object goes live, so no caller ever
  sees an empty list that fills a moment later. It runs when the object is built (first use, after a restart). On a
  reload a kept cell keeps its value and `init` does not run.
- `add` writes SQLite first, then the cell. SQLite is the truth; the cell is the live copy others watch. If the
  process dies between the two, the note is still in SQLite, and `init` loads it next time.
- The ids now come from SQLite.
- The cell has `version: 2`, a `migrate` and an `init` that takes `previous`. That is for one moment only: the reload
  from concept 4's code to this one.

**Reloading into this version.** The app is running the in-memory store from concept 4 and holds a few notes. You
reload into this code. The cell `notes` keeps its name and schema, but its **meaning** changed: before, the cell *was*
the data; now it is a copy of SQLite.

Without a bump, the reload keeps the cell with its value, and `init` does not run. The new code would serve the
in-memory notes as if they came from SQLite, but they are not in SQLite: the next restart loses them. Chord cannot
notice this: same name, same schema, only the code inside `init` changed. **Raising the version is your job.**

With `version: 2`, the reload treats the cell as changed, in two steps:

1. **`migrate(old)`** converts the old value to the new schema. It must be pure: it runs once as a trial while the
   reload is checked, and once for real. The schema did not change, so here it returns `old` unchanged. Without a
   `migrate` (or if it returns `undefined`), there is no `previous`, and the old notes are dropped.
2. **`init({ previous })`** then runs once, with the migrated value as `previous`. Unlike `migrate` it may write:
   here it inserts the in-memory notes into SQLite, then loads everything. It must be safe to run twice (it reruns if
   the reload is retried), hence `insertMissing`.

Meanwhile `NoteStore` is handed over (concept 11): running calls finish first and new calls wait, so no `add` runs
while `init` copies; then `db` is open, `init` runs, the waiting calls continue, and browsers get the whole value
again. After a restart `previous` is absent and `init` only loads.

The rule: **when the schema or the meaning of a cell changes, raise its version.** Chord refuses a schema change
without a bump; a meaning change (a different `init`) it cannot see.

**Three kinds of cells.** Cells are the live view, not the store. Most cells are one of these:

| Kind | Example | `init` | On a version bump |
| --- | --- | --- | --- |
| mirrors a source (SQLite, Durable) | `notes` from now on | reads the source, ignores `previous` | nothing to carry over: no `migrate`; bump freely |
| exists only in memory | concept 4's `notes`, drafts, UI state | `previous ?? fallback` | `migrate` converts the old value |
| large data | a transcript | loads a bounded window (the latest entries) | as a mirror |

- The `notes` cell changed kind in this concept: from memory-only to mirror. The `migrate` and the `previous` branch in
  `init` exist only for that one transition; once every running worker has reloaded past it, they can go, and the
  cell is a plain mirror: `init: () => db.value.all()`.
- Large data stays in its source. The cell holds only a window, kept current by an effect (concept 6), and methods
  return older pages on request (p2's chat has a `window` cell and a `history` method). Clients cache the pages they
  fetched.

**Resource rules:**

- On a reload, the same name and `version` keep the resource open; the new code uses the same handle.
- Chord closes resources when the object ends, in reverse order of declaration.
- **Only native values, no behaviour.** An event handler or timer set up inside `open` would keep running the old code
  after a reload, because `open` doesn't run again. Behaviour goes into effects (concept 6).
- Raise `version` when what `open` produces changes (another file, other options). Two kinds:
  - `parallel` (default): old and new can exist side by side; the new one opens first, the old one closes once nothing
    uses it anymore;
  - `exclusive` (a port, a lock): the old one must close before the new one opens (concept 11).

**Check questions**

1. Why not open the DB directly in the factory?
2. You reload from the in-memory store to this one but forget `version: 2`. What happens to the notes, now and at the
   next restart? Why doesn't Chord stop you?
3. The worker restarts. Walk through what happens to the notes until a browser sees them again.
4. You change a query inside a method. Do you raise the resource's `version`? And if you change the file name?
5. Someone put a file-change handler inside `open`. What happens after you fix that handler and reload?

*Model answers:* (1) The factory runs on every reload; each run would open another handle, never closed. (2) The reload
keeps the cell with the in-memory notes; `init` doesn't run, so they never reach SQLite, and the next restart loses
them. Chord sees the same name and schema; a changed `init` is invisible to it, so the bump is the author's job. (3) The cell
is gone with the process; the notes are in SQLite. When a browser asks again, `NoteStore` is built: `open` opens the
file, `init` loads the notes, then the object goes live and the browser gets the whole value. (4) No for the query
(method code is new anyway); yes for the file name (what `open` produces changes). (5) Nothing: `open` doesn't run
again, the old handler keeps running; that's why behaviour belongs in effects.

---

## Concept 6: Effects and operations

**The problem.** An object must react (an inbox file appears), run background work (hourly cleanup), or keep a long
task going (an OAuth login that takes minutes). Done directly in the factory, every reload would add another handler
or timer.

**The idea.** An **effect** is behaviour Chord starts and stops for you:

```ts
self.effect(onEvents(watchDir(inbox), async (file, ctx) => {
  db.value.insert(await readFile(file, { signal: ctx.signal }));
  notes.replace(ctx, db.value.all());
}));
self.effect(every("cleanup", HOUR, () => db.value.deleteOld()));
```

- An effect starts when the object is live and stops when it ends.
- When the object's **code changes**, the old effect is stopped first, then the new one starts, so they never run side
  by side. Handlers already running finish.
- A handler on **state** gets the current value again after a restart, so it must **reconcile** ("make the world match
  this value"), not blindly act.
- A named timer (`every("cleanup", …)`) keeps its next deadline across reloads.

An **operation** is long-running work an object owns, like a login flow:

```ts
const flow = self.operation(async (ctx) => runOAuth(provider, ctx));
```

It keeps its own code until it finishes, so a reload of unrelated code doesn't interrupt it.


**Check questions**

1. Why does a handler on state have to reconcile?
2. You change the cleanup interval's callback and reload. Does the hourly schedule restart from now?
3. Effect or operation for "send a daily report"? For "an OAuth login in progress"?

*Model answers:* (1) It receives the current value again after a restart; a blind action would run twice. (2) No, the
named timer keeps its deadline; only the callback changes. (3) Daily report: an effect with a named `every`; OAuth
login: an operation (long-lived, must not be interrupted by an unrelated reload).

---

## Concept 7: The facet and registries

**The problem.** A plugin must contribute things to the app it can't edit: an HTTP route, a tool for the agent, a panel
in the UI. And the plugin's objects need to share things like the DB.

**The idea.**

- A **facet** is a plugin's code for one process (its `server.ts`, `worker.ts`, `web.tsx` or `tui.ts`). The facet's
  setup is itself an object that lives as long as the process: it can declare resources and state, and its served
  objects share them.
- A **registry** is a named table someone owns (the app or a plugin) and others contribute to:

```ts
export default defineFacet((host, self) => {
  const db = self.resource("db", { version: 1 }, () => openDb(host.value(DataDir)), (db) => db.close());
  self.register(Routes, { "GET /notes/export": (req, res, access, ctx) => exportNotes(db.value, res) });
  host.serve(NoteStore, (input, principal, self) => ({ /* uses db */ }));
});
```

- The owner declares the registry and reads it (`host.registry(Routes).table()`); plugins register entries.
- Entries live as long as the plugin is loaded; a reload swaps the whole table at once, so there is never a moment with
  a missing route.
- Registries are per process: a worker facet can't add a server route. Things that cross processes go through objects.
- Only the facet and `lifetime: "host"` objects register (an object that comes and goes would make its entries flicker).


**Check questions**

1. Why can't an ordinary (referenced) object register a route?
2. Your worker facet wants an HTTP route. How?
3. What happens to a plugin's routes when the plugin is removed?

*Model answers:* (1) Its entries would exist only while someone references it: the route would flicker. (2) The server
facet registers the route; the handler calls an object in the worker. (3) They disappear with the plugin's facet.

---

## Concept 8: Host values

**The problem.** Some things exist once per process and belong to the app, not to any plugin: the data folder, the
agent runtime (Durable harness), the session's current directory.

**The idea.** The app provides them as **host values**, typed by a key:

```ts
const dir = host.value(DataDir);           // a string
const harness = host.value(Harness);       // the Durable harness
```

- They are there before any plugin loads; no waiting, no `!`.
- Each key has a version; a plugin built against an older version gets an adapted value or a clear error at load.


**Check questions**

1. Why are host values not ordinary objects?
2. What happens when a plugin asks for a key the process doesn't provide?

*Model answers:* (1) They are native, process-wide things owned by the app, not data or methods, and must exist before
plugins load. (2) It fails with a clear error when the plugin loads.

---

## Concept 9: Who is here (`host.references`)

**The problem.** The owner wants to see which guests are in a session; the worker should stay running while someone
looks at it.

**The idea.** Chord knows which references exist, so it can tell you:

```ts
const viewers = self.derive([host.references(Chat)], (refs) => refs.length);
```

`host.references(Type)` lists who (input, principal, how many clients) holds references to objects of a type in this
process. A disconnect counts as leaving.


**Check questions**

1. Why is this better than each client registering itself in a list?

*Model answer:* Chord already tracks references and updates them on connect, release, revocation and disconnect; no
extra objects, no enter/leave races on reload.

---

## Concept 10: `ctx` and call trees

**The idea.** Every method, handler and operation gets a `ctx`:

- `ctx.signal`: fires when the call is cancelled (the caller gave up, the object ended, or a reload needs it to stop);
- `ctx.get`: references that live for this call;
- the process's own principal.

A **call tree** is everything one starting point causes (a click in the browser, an event), across objects and
processes.

**The rule:** pass `ctx` or `ctx.signal` to everything you wait on (`fetch(url, { signal: ctx.signal })`). Then a long
call can be stopped cleanly.

**Check questions**

1. A method waits on `fetch` without the signal. What goes wrong when it must be stopped?

*Model answer:* It can't be interrupted; it keeps running until the fetch returns, and anything that has to wait for it
(a reload's handover) waits longer.

---

## Concept 11: Reload

**The problem.** You change a plugin's code. Everything should keep running: open terminals, running scripts, the
agent's current answer, connected browsers, without restarting any process.

**The idea, in one sentence:** behaviour is replaced at once; storage is handed over.

On each process:

1. **Prepare:** the new code is loaded and checked: factories run as a trial (no side effects), contracts are checked
   against every current caller, new `parallel` resources open. If anything fails, nothing changes.
2. **Publish:** in one step, every call from now on reaches the new code. Objects whose storage changes (a state
   version bump, an `exclusive` resource) are fenced in that same step: new calls to them wait. All other objects are
   done: their effects restart with the new code; calls already running finish their old code. An object that was
   still being built at that moment starts over with the new code.

   Objects that merely hold a reference to a fenced object are **not** fenced: their calls run, and wait only when they
   reach the fenced object. (Fencing them would deadlock: their running call waits for the handover, which would wait
   for them to finish.)
3. **Hand over** each fenced object:
   1. its running calls, operations and handlers finish (after a deadline they are asked to stop via `ctx.signal`;
      nothing is closed while they still run; a call that re-enters the object from inside is let through);
   2. bumped cells get their new value in a staged copy: `migrate` converts the old value (it already ran once in
      prepare as a trial, so it must be pure), then `init({ previous })` runs once with the result and may do I/O
      (concept 5). `exclusive` resources are closed and reopened;
   3. on success the new state, code and effects are installed and the waiting calls continue.

If a handover fails (a port is busy, a migration throws), **only that object** fails; you fix the code and reload, and
it comes back in place.

What callers see: usually nothing; during a handover, a short wait; a call running on that object past the deadline is
cancelled.

**Example:** you add `tags` to the note schema (and a column to the SQLite table) and raise the cell to version 3. No
`migrate` is needed: the truth is in SQLite. The `NoteStore` objects are handed over: their calls finish, `init` loads
the notes with their tags, and the waiting calls continue. Browsers get the new value. Nothing else stops.


**Check questions**

1. You fix a bug in a method and reload. What happens to a call to that method that is running right now?
2. You raise the version of a sandbox resource (parallel) while a script runs in the old sandbox. What happens?
3. Why can old code never write state that was just migrated?

*Model answers:* (1) It finishes its old code; new calls get the fix. (2) The new sandbox opens; new scripts use it;
the running script keeps the old one, which closes when the script ends. (3) The object's calls are drained before the
migration, and new calls wait until it is done.

---

## Concept 12: Versions and adapters

**The problem.** A plugin written for an older p2 should keep working when p2 changes. And a plugin's own state may
change shape over time.

**Two kinds of versions:**

- **Interface versions**, between parties that change independently: object types, registries, host values. The
  consumer brings the version it was built against; the owner provides an **adapter** for old versions; anything
  else fails with a clear error when the plugin loads.

```ts
host.serve(Notes, factory, { accepts: { 1: (current) => oldView(current) } });   // old callers keep working
```

- **Internal versions**, between old and new code of the same object: state and resource versions. Nobody adapts
  them; a bump triggers a handover (concept 11) with `migrate` or a reopen.


**Check questions**

1. A plugin was built against `Notes` version 1; p2 now serves version 2. When does it keep working?
2. Why don't state versions get adapters?

*Model answers:* (1) If version 2's provider declares an adapter for version 1 (or the change was compatible and the
version didn't change); otherwise it fails at load. (2) They aren't shared with anyone else: only the object's own old
and new code; a migration converts the value once.

---

## Glossary

| Term | Meaning |
| --- | --- |
| facet | a plugin's code for one process; itself a long-lived object |
| object type | the description of objects: name, input, members, version, host |
| object | one instance per (type, input, caller) |
| principal | who calls, stamped by the server |
| variant | the set of members a caller gets |
| reference | what `get` returns; keeps the object alive |
| state | named, observable data; survives reloads |
| resource | a named native thing; survives reloads |
| effect | behaviour restarted when code changes |
| operation | long-running owned work |
| registry | a declared, versioned table of contributions |
| host value | a native value the app provides |
| handover | replacing an object's storage in place during a reload |
