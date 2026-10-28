
# A First Object {#first-object lede="A plugin, a contract, a factory, and a browser tab that calls it on another process."}

Studio's first feature is session notes: a list of short notes per session, shown in a panel, that anyone allowed can
add to. Several places need "the notes of S1": the owner's tab, a guest's tab, later a download route and an agent
tool. If each built its own copy, the copies would drift apart and nobody would know when to clean them up. In Chord
there is **one object** for "the notes of S1", everyone asks for it by its type and input, and Chord routes them all to it.

## The plugin's files

A plugin is a directory with a `package.json`. Its `name` (npm style, globally unique and stable) is the plugin's
identity: Chord finds its stored documents, reports its errors and orders its contributions by it, never by a
directory name or load order.

| File | Runs on | Holds |
| --- | --- | --- |
| `package.json` | read by the loader | `"name": "@studio/notes"` |
| `contract.ts` | every host that imports it | object types: names, shapes, method signatures; no running code |
| `worker.ts` | every session worker | the worker facet |
| `server.ts` | the server | the server facet (later: the download route) |
| `web.tsx` | browser tabs | the web facet: the panel |

## The contract

An object type is a contract: a name, an **input** (the object's key among objects of this type), a **placement**
(on which host it lives, computed from the input), the **members** (state you can read and methods you can call) and a **version**.

```ts
// notes/contract.ts
import { arr, int, method, obj, remote, str, type Static } from "@earendil-works/chord/next";
import { Session } from "@studio/core/hosts";

export const Note = obj({ id: str(), text: str({ max: 2000 }), by: str(), at: int() });
export type Note = Static<typeof Note>;

export const Notes = remote("notes", {
  version: 1,
  input: obj({ session: str() }),                          // the key: { session: "S1" }
  placement: ({ session }) => Session({ id: session }),    // input → the host's address
  variants: {
    editor: {
      state: { notes: obj({ items: arr(Note) }) },
      methods: {
        add: method(obj({ text: str({ min: 1, max: 2000 }) }), str()),   // returns the new id
        remove: method(obj({ id: str() })),                              // no result
      },
    },
  },
});
```

`remote` means objects of this type can be reached from any host, across links (chapter IV introduces `local`). The
schema helpers (`obj`, `str`, `int`, `arr`, `map`, `opt`, `lit`, `oneOf`, `union`, `bool`, `num`, `nul`, `bytes`,
`unknown`) return ordinary TypeBox schemas; short options such as `{ min, max }` bound lengths or values. Schemas must
describe data: no callbacks, no class instances, no custom codecs.

`method()` has four forms: `method()` (no arguments, no result), `method(args)`, `method(args, result)` and
`method(undefined, result)`.

A contract contains no code that runs, so every host can import it. When you declare it, Chord materializes its
description and computes a **fingerprint**, a hash of its input, variants and members. Two hosts compare contracts by
version and fingerprint (chapter XVI). Placement is not part of the fingerprint.

## Placement

The input says *which* object; `placement` says *where* it lives. The caller runs the placement function on the input and sends the resulting address with its request; the server
routes by it. The provider runs the function too and refuses an object that is not its own with `invalid/placement`.
So a worker for S2 never builds "Notes for S1", even if a caller has an outdated rule. Because placement is a typed
function, a `Session` placement on a type whose input has no `session` field does not compile.

Inputs are **normalized** before anything else: defaults are applied, unknown fields removed, and a canonical key
computed. `{ session: "S1" }` and `{ session: "S1", extra: 1 }` are the same object.

## The facet and the factory

A **facet** is a plugin's setup for one kind of host. It runs once when the plugin loads on that host and tells the
host which object types it serves:

```ts
// notes/worker.ts
import { defineState } from "@earendil-works/chord/next";
import { defineFacet } from "@studio/core";          // Studio's defineFacet: principals typed as Studio's P (chapter III)
import { Note, Notes } from "./contract.ts";

const NoteList = defineState("notes.list", {      // a document (chapter V); in memory for now
  schema: obj({ items: arr(Note) }),
  version: 1,
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

export default defineFacet((host, self) => {
  host.serve(Notes, ({ session }, principal, self) => {
    const list = self.state(NoteList);            // THE note list of this object
    return {
      variant: "editor",
      notes: list,                                // a document handle is a readable: expose it as state
      add: ({ text }, ctx) =>
        self.tx(async (tx) => {
          const id = uuidv7();
          (await tx.draft(list)).items.push({ id, text, by: "someone", at: Date.now() });
          return id;
        }, ctx),
      remove: ({ id }, ctx) =>
        list.change((d) => { d.items = d.items.filter((n) => n.id !== id); }, ctx),
    };
  });
});
```

Read `host.serve(Notes, factory)` as "this host builds `Notes` objects like this". The factory receives the
normalized input, the caller's principal (chapter III) and `self`, through which it declares what the object needs.
It returns the members of one variant, tagged with `variant`.

**Factories declare; Chord activates.** The factory is synchronous and has no side effects. It does not await, open
files or start timers. `self.state(NoteList)` does not load anything: it declares that the object has this document
and returns a **handle** that stays valid for the object's whole life. Chord then performs the activation: it loads the
document, binds references, opens OS handles, starts routines, and only then lets calls in. The rule exists for
reload: a reload runs the factory again, and anything the factory did itself would happen twice.

## Calling it

```tsx
// notes/web.tsx
export function NotesPanel({ session }: { session: string }) {
  const notes = useRef(Notes, { session });                 // app-side hook over host.get / release
  const items = useReadable(notes?.notes)?.items ?? [];
  return (
    <section>
      {items.map((n) => <p key={n.id}>{n.text}</p>)}
      <AddBox onAdd={(text) => notes?.add({ text })} />
    </section>
  );
}
```

Underneath the hooks is the reference API:

```ts
const notes = await client.get(Notes, { session: "S1" });   // live and hydrated once awaited
notes.notes.value.items;                                    // the current list
notes.notes.subscribe((v) => render(v.items));              // every committed change
const id = await notes.add({ text: "check the flaky test" });
notes.release();                                            // the object may end now
```

An awaited reference is **live and hydrated**: every state member has a value. State members are **readables**:
`.value` is the current value, `subscribe` is called after every commit. The first `get` for `{ session: "S1" }` runs
the factory; every later `get` for the same input and caller shares that object. The object ends when the last
reference is released (a type may keep it a little longer with `linger`).

:::sequence animate | A call to add. Arguments are checked once at the provider; the commit reaches the viewer as one small change.
actor tab "browser tab"
actor server "server" muted
actor worker "worker S1" blue
actor obj "Notes { S1 }" accent
tab -> server: call add { text }
server -> worker: relay (header only)
worker -> obj: strip + validate args
obj => obj: self.tx: push note, commit
obj --> worker: result: id
worker --> server: state: ops of the commit
worker --> server: result
server --> tab: state, then result
:::

## Two rules for members

**Methods return data, never objects.** A method that wants to point you to another object returns its address
(`{ session: "S2" }`), and you `get` it yourself. That keeps every reference owned by someone who releases it.

**No callbacks as arguments.** A callback carries code, and everything it closes over, from one object into another.
Suppose an inbox object passed `onFile` to another object, which stored it. After a reload of the inbox's plugin, the
other object still calls the *old* `onFile`; after the inbox ends, it calls into an object whose file watcher is
already closed. Chord forbids this by construction: members are data (JSON plus bytes). Behaviour from elsewhere goes
through registries (chapter XIII), multi-step work through jobs (XI), input from a person through flows (XII).

## What is wrong with this version

This first version works for one person. It has two problems, which the next two chapters fix. Everyone gets the
`editor` variant, including a read-only guest. And, less obvious, the owner and a guest do not see the same notes: as
chapter III shows, a remote object exists per caller, so each caller's `Notes` object has its own `NoteList`.

:::note | Built so far
`remote`, `method`, the schema helpers, `Static` and fingerprints are built (`src/next/contracts/`). Serving, `get`,
references and documents are layers L3 to L5.
:::
