
# Changing Contracts {#contracts lede="How a contract gets a new version while old tabs, old workers and old plugins are still talking to it."}

Chapter XV ended with a tab that calls into a worker on another revision. That case is short-lived: the rollout
finishes and both sides run the same code. Other cases last longer. A phone kept a tab open overnight with yesterday's
web bundle. A plugin from another author was built against `Notes` version 1 and is not updated yet. In both, a
consumer holds a contract that the provider no longer has. This chapter is about what the provider does then. It is
also the one part of Chord v2 that is built: everything in the sections on `evolve`, `checkAccepts` and fingerprints
runs today in `packages/chord/src/next/contracts/`.

## What has a version

Everything that is stored or crosses a boundary has a version. Each surface handles an old version its own way:

| Surface | Version | When an old one shows up | Chapter |
| --- | --- | --- | --- |
| object type (contract) | `version` plus fingerprint | `evolve` and `checkAccepts` on the provider; otherwise `contract_mismatch` | this one |
| document | `version` plus schema fingerprint | pure `migrate` on access; a schema change without a bump fails the object `broken` | V |
| job | `version` | `accepts` on outcomes and `running`; `blocked` without an adapter | XI |
| registry | `version` | `accepts` adapts contributions; one without a match is left out and reported | XIII |
| native | none | the object restarts on reload | IX |
| Durable tasks and documents | Durable's `version` | Durable's `migrate` | XIV |
| link protocol | protocol version | refused; hosts update together, a web page reloads | XVII |
| UI components, Chord and app APIs | none yet | exposed as they are; an SDK will version them later | |

The rule behind every row is the same as for documents: **every change bumps the version**, additive ones included.
Chord never guesses compatibility from the shape of two schemas.

## A history, not a file of versions

A contract history starts with a **base**: a full `remote()` or `local()` declaration with an explicit `version`. The
`Notes` contract from chapters II and III is a base at version 1. Studio now wants pinned notes: notes get a `pinned`
flag and editors get a `pin` method. Instead of editing the declaration, the plugin continues the history:

```ts
// notes/contract.ts
import { bool, evolve, nul } from "@earendil-works/chord/next";

export const NoteV2 = obj({ id: str(), text: str({ max: 2000 }), by: str(), at: int(), pinned: bool() });
export const PublicNoteV2 = obj({ id: str(), text: str(), at: int(), pinned: bool() });

export const NotesV2 = evolve(Notes, (e) =>
  e.state("editor", "notes", obj({ items: arr(NoteV2) }))
    .state("reader", "notes", obj({ items: arr(PublicNoteV2) }))
    .addMethod("editor", "pin", obj({ id: str(), pinned: bool() }), nul()),
);
```

`evolve(prev, (e) => …)` appends one version to `prev`'s history: `NotesV2.version` is 2, and `NotesV2` still knows
version 1 exactly as it was declared. Every version is **materialized and fingerprinted at declaration**. That is what
makes old code safe: an old plugin bundle that contains its own copy of `Notes` version 1 computes the same
fingerprint as the history inside `NotesV2`. There is no build step, no generated file and no fingerprint copied by
hand.

The edits:

| Edit | Changes | Kind |
| --- | --- | --- |
| `e.state(variant, member, schema)` | one state member of one variant | remote |
| `e.addState(variant, member, schema)` / `e.removeState(variant, member)` | adds or removes a state member | remote |
| `e.state(member, schema)`, `e.addState(member, schema)`, `e.removeState(member)` | the same, flat | local |
| `e.args(name, schema)` / `e.result(name, schema)` | one side of a method | both |
| `e.method(name, args, result)` | both sides of a method | both |
| `e.addMethod(variant, name, args, result)` | adds a method (or an existing one to another variant, same signature) | remote |
| `e.addMethod(name, args, result)` | adds a method | local |
| `e.removeMethod(name)` | removes a method from every variant | both |

Edits chain. The `method(...)` wrapper appears only in base declarations; edits take the schemas directly, so a
method without a result is added with `nul()`. The rules of chapter III still hold across versions: a method has one
signature in every variant, and a member's kind never changes, not even after it was removed and added again.

**What `evolve` cannot do:** change the input or the set of variants. Both change what an object *is* (its identity,
who gets which members), and no adapter can turn one into the other. That needs a new history base, below.

## The provider says what it accepts

`NotesV2` says what changed. It does not say how version 1 consumers are served; the **provider** decides that, with
mappings that live in its own code, never in the contract. The worker facet declares them with `checkAccepts`:

```ts
// notes/worker.ts
import { checkAccepts } from "@earendil-works/chord/next";

const toV1 = ({ pinned, ...note }: Static<typeof NoteV2>) => note;
const toPublicV1 = ({ pinned, ...note }: Static<typeof PublicNoteV2>) => note;

const notesAccepts = checkAccepts(NotesV2, {
  1: {
    state: {
      editor: { notes: (current) => ({ items: current.items.map(toV1) }) },
      reader: { notes: (current) => ({ items: current.items.map(toPublicV1) }) },
    },
    methods: {},                                   // add and remove did not change; pin is new
  },
});
// notesAccepts.versions: [{ version: 1, fingerprint: Notes.fingerprint }]

host.serve(NotesV2, notesFactory, { accepts: notesAccepts });    // working name for the objects-layer option
```

`checkAccepts` is **pure**: it checks the mappings without calling them and returns only the version metadata of the
old versions it lists. A provider that lists nothing accepts only its current version. The objects layer later
compares a consumer's version and fingerprint against this list.

The mappings point in the direction the data flows:

| Member in the old version | Mapping | Direction |
| --- | --- | --- |
| state, changed | `(currentMember) => oldMember` | provider's current value to what the old consumer expects |
| state, removed | `(currentVariantState) => oldMember`, or `"refuse"` | receives the whole current state of that variant |
| method arguments, changed | `args: (old) => current` | old caller's arguments to current ones |
| method result, changed | `result: (current) => old` | current result back to the old shape |
| method, changed or removed | `{ call: async (oldArgs, ctx) => oldResult }`, or `"refuse"` | replaces the method for old callers |
| member added since | nothing | an old consumer never asks for it |

A changed state member cannot be refused: the old consumer still has that member and must get a value. A removed one
can be computed from what the variant has now, or refused. `e.method(name, args, result)` replaces both sides and
therefore needs both mappings, even if one side stayed the same (then an identity mapping).

**Required, at type level and again at runtime.** For every member that exists in the old version and changed or was
removed since, the mapping is required by the type of `checkAccepts`. Because plugins are bundled without type
checks, the same check runs at declaration: a missing mapping, a key for a member that needs none, an unknown version
or a wrong shape throws, naming the member's path (for example `accepts[1].state.reader.notes`). An absent `state` or
`methods` section counts as empty and may be left out only when nothing there needs a mapping.

**Conservative with no-op edits.** An edit that sets a schema to what it already was, or changes a member and then
changes it back, still requires an identity mapping. TypeScript erases constraints such as `{ max: 2000 }` from the
static type, so two schemas that look the same to the compiler may differ; Chord does not try to tell.

### Old versions map straight to the current one

Studio later replaces `remove` with `archive`, which keeps the note in a trash list:

```ts
export const NotesV3 = evolve(NotesV2, (e) =>
  e.removeMethod("remove").addMethod("editor", "archive", obj({ id: str() }), nul()),
);

const notesAccepts = checkAccepts(NotesV3, {
  1: {
    state: { editor: { notes: (c) => ({ items: c.items.map(toV1) }) }, reader: { notes: (c) => ({ items: c.items.map(toPublicV1) }) } },
    methods: { remove: { call: async ({ id }, ctx) => { await archiveNote(id, ctx); return null; } } },
  },
  2: { methods: { remove: { call: async ({ id }, ctx) => { await archiveNote(id, ctx); return null; } } } },
});
```

Each entry maps **one old version directly to the current one**, not through the versions in between. Version 1
needs the state mappings (its notes have no `pinned`) and the `remove` replacement; version 2 needs only the
`remove` replacement, and leaves `state` out because its state is unchanged. A member that an old version never had
needs nothing for that version, even if it was added, changed and removed later. Dropping support for version 1 is
deleting its entry: version 1 consumers then get `contract_mismatch`.

## Binding an old consumer

A hold carries only the consumer's contract **version and fingerprint**, never a description of the contract (R6).
The provider decides with its own schemas:

:::flow wide animate | What a provider does with a hold. The decision uses only the provider's own history; a peer's schema is never an input.
row "The hold arrives"
box hold "hold" "version 1, fingerprint F1" blue
box cur "equal to current?" "version and fingerprint"
box acc "accepted old version?" "F1 from the provider's own history"
row "Outcome" accent
box live "bind" "current members"
box adapted "bind adapted" "through the mappings" accent
box mismatch "`contract_mismatch`" "or updating, during a rollout" muted
arrow hold -> cur
arrow cur -> live "yes"
arrow cur -> acc "no"
arrow acc -> adapted "yes"
arrow acc -> mismatch "no"
note "A mismatch fails only that consumer's binding. The provider object and its other bindings are not affected."
:::

Once a version 1 tab is bound, it is served as if version 1 were current:

:::steps | A version 1 tab on a version 3 worker
+++ Bind
The tab holds `Notes { S1 }` with version 1 and fingerprint F1. The worker's history computes F1 for version 1, and
`notesAccepts` lists version 1, so the hold binds adapted. The tab gets the `editor` variant as version 1 defined it:
`notes`, `add`, `remove`. It never sees `pin` or `archive`.
+++ State through the mapping
Chord serves the adapted state like a derive of the provider's state: it applies the mapping to the current value
and keeps the result per binding. The snapshot the tab receives has no `pinned` fields.
+++ A commit
The owner pins a note from a current tab. The worker sends the current tab the draft's ops. For the version 1 tab,
Chord applies the mapping to the new value and sends the difference to its last adapted value (`diffRevisions`). The
mapping produced nothing new for a pin, so the version 1 tab receives no change at all. A large list is never resent
whole on every commit.
+++ A call
The tab calls `remove({ id })`. Its arguments are checked against the provider's own version 1 schema, then the
`call` replacement runs `archiveNote` on version 3 code. Its `null` result is what version 1 expects. Had the method
only changed, `args` would have mapped the arguments forward and `result` the result back.
+++ The worker moves on
A later revision drops the version 1 entry. When the tab re-holds (or the worker restarts and the tab binds again),
the hold gets `contract_mismatch`, and Studio's panel shows "reload to update" instead of failing silently.
:::

## A new history base

Some changes cannot be adapted. Studio decides that notes belong to a project, not a session: the input changes from
`{ session }` to `{ project }`. That is a new base, written in full, with an explicit version that continues the
published numbering:

```ts
export const NotesV4 = remote("notes", {
  version: 4,                                      // explicit: the published history used 1 to 3
  input: obj({ project: str() }),
  placement: () => Server,
  variants: {
    editor: { state: { notes: obj({ items: arr(NoteV2) }) }, methods: { add: method(…), pin: method(…), archive: method(…) } },
    reader: { state: { notes: obj({ items: arr(PublicNoteV2) }) } },
  },
});
// checkAccepts(NotesV4).versions is empty
```

A new base has no history before its version and **cannot accept older versions**, not even for an additive change.
Every consumer built against versions 1 to 3 gets `contract_mismatch` and must update. Later `evolve` calls continue
from version 4. The same applies to a change of the variant set. Do not spread an older declaration into a new one or
copy its fingerprint; the contract objects are branded and `evolve` and `checkAccepts` reject copies.

## Local contracts

`local` contracts (chapter IV) evolve the same way, with a flat members map and no variants:

```ts
export const SessionInfoV2 = evolve(SessionInfo, (e) => e.state("init", InitV2));
checkAccepts(SessionInfoV2, { 1: { state: { init: (current) => toInitV1(current) }, methods: {} } });
```

Same-host consumers of a `local` type are usually reloaded together with their provider, but not always: another
plugin on the same host may be built against an older version. The rules are identical; only the variant argument is
missing.

## Implementing a contract

`Implementation<typeof NotesV2>` is the type of everything a provider must supply for the current version: one state
getter per member and variant, and one asynchronous method per method, each receiving `(args, ctx)`:

```ts
const impl: Implementation<typeof NotesV2> = {
  state: { editor: { notes: () => list.value }, reader: { notes: () => publicList.value } },
  methods: { add: async ({ text }, ctx) => addNote(text, ctx), remove: async ({ id }) => removeNote(id), pin: async (a) => pin(a) },
};
```

Keep declaration types **inferred** (no annotation on `NotesV2`): the inferred type carries the complete history, and
`checkAccepts` needs it to know what changed.

:::review | Review: L1's implementation shape and the factory's return value
`Implementation<C>` in `src/next/contracts/types.ts` is `{ state: { variant: { member: getter } }, methods }`. The
design's factories (`design.md` §6, used throughout this guide) return `{ variant, member: value, method: fn }`.
The objects layer (L4) has to connect the two, and also define how `serve` receives the checked accepts (this guide
uses the working name `{ accepts }` as a third argument) and what `"refuse"` does at runtime. The natural reading,
used in the stepper above, is that a refused method call and a hold that needs a refused state member end with
`contract_mismatch`; no source says so.
:::

## The fingerprint

The fingerprint is a 64-bit hash (`hash64`, portable across runtimes) of a **normal form** of the contract's
schemas. The normal form decides what counts as a change:

| Ignored | Significant |
| --- | --- |
| order of object keys, `required` and `enum` (sorted) | order of union and intersection branches (`anyOf`, `oneOf`, `allOf`) and of tuples |
| annotations on schema nodes: `title`, `description`, `examples`, `$comment`, `deprecated` | defaults, formats, patterns, bounds, `$ref` names |
| placement | input, variants, member kinds and every member schema |

Union order is significant because it is meaning: TypeBox picks defaults and decodes by the first matching branch.
Annotations are dropped only on schema nodes; an object property that happens to be named `title` is data and counts.

Only data schemas are allowed. One walker copies, validates and normalizes each schema against a **whitelist of
TypeBox keywords**: primitives, arrays and tuples, objects and records, unions and intersections, `$defs` and `$ref`
(use `$ref` for recursive types), constraints and annotations. Conditional and dependent schemas, `not`,
`definitions`, `contentSchema`, `unevaluated*`, `contains`, `propertyNames`, unknown keywords, executable or custom
TypeBox features, arbitrary `Unsafe` and refinements, accessors, symbols and cyclic objects are rejected at
declaration. Bytes are the one special leaf: `bytes({ min, max })` checks a `Uint8Array` and has the data marker
`{ type: "bytes", minLength?, maxLength? }`, so it hashes like any schema; TypeBox's checking still works on it.

Schemas are deep-copied into a private, frozen history; your own schema objects are copied, not frozen.
`NORMAL_FORM_VERSION` is part of every digest, so a change of the normal form is a link protocol change.

**Not a security boundary.** A fingerprint says "we were compiled against the same contract"; it proves nothing. A
hostile client can send any fingerprint it likes. Providers therefore always validate arguments with their own
schemas (chapter IV), whatever the fingerprint says.

## Rules of thumb

- Treat a published contract like a published API: every change is `evolve`, every `evolve` needs a decision about
  old consumers.
- Keep mappings small and pure. A state mapping runs for every commit and every adapted binding; make it a map over
  the value, not a query.
- Accept the versions your users still run (one or two back during a normal rollout), and delete entries when the
  metrics show no old bindings.
- Change the input or the variants only with a new base, and only when updating every consumer is acceptable.
- Contract, document and job versions are separate and each is decided on its own. Pinned notes needed `NotesV2`
  for the wire and `NoteList` version 2 with a `migrate` that adds `pinned: false` (chapter V), but no new
  `ImportJob` version, because its outcome did not change.

:::note | Built so far
This chapter's contract layer is built: `packages/chord/src/next/contracts/` (commit `7d2bb8ea8`, about 1,300 lines
with `remote`, `local`, `method`, `evolve`, `checkAccepts`, `Implementation`, the schema helpers, `fingerprintOf`,
`schemaNormalForm` and `NORMAL_FORM_VERSION`), with nine test files covering evolution, fingerprints, the hash,
local contracts, long chains, schemas, types and review findings. It stands alone: it hosts nothing, calls no
mapping and does not import the frozen runtime. Binding by version and fingerprint, adapted state and calls belong to
the objects and protocol layers, not built yet.
:::
