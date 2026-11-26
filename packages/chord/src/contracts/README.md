# contracts

Declarations of Chord object types: what an object's state and methods look like, version by version.

## For apps (`index.ts`)

```ts
import { arr, evolve, grantable, hostKind, type Implementation, method, obj, remote, str } from "./index.ts";

export const Session = hostKind("session", { id: str() });   // a kind of addressable host, params like a contract's
const Note = obj({ text: str() });
export const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),   // where an object lives; not in the fingerprint
	state: { notes: arr(Note) },
	methods: { add: grantable(method(Note, str())), clear: grantable(method()) },  // only for callers granted them
	flags: { export: messages.message("flagExport") },        // a right that is no member; its label a message
});
export const Notes = evolve(NotesV1, (e) => e.args("add", obj({ text: str(), tag: str() })));
type NotesProvider = Implementation<typeof Notes>; // { notes, add(args, context), clear(context) }
```

- `remote(name, { version, params, hostAddress, state, methods, events, flags })` (slice 15): one shape for every
  caller, with `state` (schemas), `methods` (`method(args?, result?)`; an omitted side is `null`, and a method whose
  arguments are `null` omits them: `clear(context)`) and `events` (schemas of the JSON values the object emits,
  decision "Events: fire-and-forget members"); a member marked `grantable(...)` exists for a caller only if its
  admission granted it, and `flags: { name: label }` are rights that are no member, each `label` a message as data
  (`MessageData`, `message.ts`; declaration refuses another value, `isMessageData`, but checks no catalog:
  `messages.message(key)` does, by its type), which the access UI renders. `GrantableName<C>` is the union of
  a contract's grantable members and flags. `local(name, { version, params, members })`: one flat map, where a schema is state, `method(...)` a
  method, `keyed(schema)` a keyed member and `event(schema)` an event member.
- `admission: obj(...)` (remote only, optional; slice 14): the JSON data the type's admission hands its factory about
  a caller besides `granted` (`AdmittedOf<C>`: the data and `granted`, a set; `AllowedOf<C>` what `allow` takes, with
  `granted` a list; JSON only, no `bytes()`, no field `granted`). Never part of the fingerprint and never validated; it has a
  fingerprint of its own (`contractData(contract).admission`), which a reload's staging compares. `evolve`'s
  `admission(schema)` replaces it, as the last edit of a version.
- `hostAddress(params) => Address` (remote only, required; a declaration error without it): the address of the host that serves the object for these
  params (`host/`'s routing table). The caller computes it and sends it with its hold, so a relay routes by the address
  alone. It is not part of the normal form or the fingerprint and `evolve` carries it.
- `hostKind(name, params?)`: a kind of addressable host (`Server = hostKind("server")`, `Session = hostKind("session",
  { id: str() })`); `params` follow the params policy below. Calling it makes an `Address { kind, params, key }`, its
  key built like an identity key (`session|S1`); two addresses are equal when their keys are. The params are checked
  where the address is routed or served (`invalid/host_address`), not when it is made. No host-name strings in app code.
- Schema helpers: `str`, `num`, `int`, `bool`, `nul`, `lit`, `oneOf`, `union`, `obj`, `arr`, `map`, `opt`, `bytes`,
  `unknown`, `Schema` and `Static`, over `@earendil-works/pi-schema`'s builders: plain JSON Schema typed with the values
  it accepts. They keep the shapes contracts were fingerprinted with: `lit` carries its JSON `type`, `oneOf(...)` is a
  union of `lit`s, `map` one pattern property (`^.*$`), `obj` is closed. `opt(...)` marks an object field (or a table
  column) optional and is no schema elsewhere. Any other JSON Schema object of the vocabulary below works too; a
  non-enumerable key (a TypeBox schema's metadata) is refused. `format` is an annotation: it is part of the normal form
  and the fingerprint, but no format is checked.
- `evolve(previous, (e) => e...)`: the next version from structured edits (`state`, `addState`, `removeState`, `args`,
  `result`, `method`, `addMethod`, `removeMethod`, `keyed`, `addKeyed`, `removeKeyed`, `event`, `addEvent`,
  `removeEvent`; the same for both kinds, a remote contract's `add…` edits taking `grantable(...)`); it must return the
  editor it was given. Whether a member is grantable and the flags never change by evolution (a new history base).
- `memberNames(contract)`: the names of the state members, methods and event members of a contract's current version,
  grantable ones included, in the order declared (`{ state, methods, events }`; without a local contract's keyed and
  `queries` members): for an app's helper that fills a view's implementation from a store's reference.
- Types: `Contract`, `Implementation<C, X>` (what a factory returns: for `local` a `Watchable` per state member, an
  `EventMember` per event member (an `EventSource` of its own or a reference's member) and a function per method,
  `(args, context)` or `(context)` without arguments; for `remote` every member, grantable state and event members as
  builders `() => …`; `X` is the context type the methods get), `ParamsOf<C>`, `AcceptsTable<C>` (the older versions a provider serves, with their mappings),
  `HostKind`, `Address<K>`, `KindShape` and `ParamsOfKind<K>`; for events `EventMember<T>` (`on(listener, ctx)`, what
  references expose), `EventSource<T>` (adds `emit`, what `self.events<T>()` returns), `EventSubscription` (`stop`) and
  `EventDeclaration` (the local marker's type).
- The types a contract's inferred type holds are all exported, so a package that emits declarations for its contracts
  names them through this entry point: the schema types (`StringSchema`, …, `LiteralsSchema` for `oneOf(...)`), the
  markers' (`Method`, `KeyedMember`, `QueriesMember`, `EventDeclaration`, `Grantable`) and `HostKeyed` (a keyed member with a host
  kind).

Rules:

- Declarations are checked once and fail with an `Error` naming the path (`notes.methods.add.args`). A contract
  keeps its own copies of its schemas: changing a schema object after declaring it changes nothing.
- A member name has one kind (state, keyed, method or event) for the whole history, and is a member or a flag, never
  both. Event schemas are JSON only (no `bytes()` leaf: refused at declaration). `grantable` is refused in a local
  contract.
- `then`, `release`, `granted`, `state` and `retry` are refused as member and flag names: a reference has them (`then` would
  make an awaited reference thenable).
- `$bytes` is reserved only in the values of a method whose argument or result schema has a `bytes()` leaf: there it
  marks a byte segment on a link (an own key `$bytes` fails `invalid/args` when it crosses one); everywhere else it is
  ordinary data.
- Every object inside a method's arguments is closed (`additionalProperties: false`); `obj()` always is, records
  (`map()`) are allowed.
- Params are required `str()`, `int()`, `bool()` or `oneOf(...)` of strings. Params, whether a member is grantable and the flags never
  change by evolution: changing them is a new history base, a new declaration with no accepted older versions.
- Mappings in an `AcceptsTable` are direct (old version to current); when a version is added, update every accepted
  version's mappings. A mapping is required per edit after the accepted version, even for a no-op edit. A changed event
  member maps each current value back (`events`, flat by member, as `state`)
  or refuses that version's binding (`"refuse"`); a removed or an added one needs none (an older consumer receives none
  of a removed one).
- Contracts are branded: a spread or hand-built copy is refused everywhere.

## For Chord's layers (`internal.ts`)

- `checkAccepts(contract, accepts)`: validates an accepts table without calling a mapping; returns the accepted
  versions (version and fingerprint).
- `contractData(contract)`: the Chord-owned data behind a handle (its `hostAddress`, its flags, its versions with
  their `MembersData`, grantable names, `grants` (grantable members and flags, sorted: the wire's indexes),
  `MethodData` and schema snapshots, its `ParamsData`). Type-level helpers: `ShapeOf`, `CurrentMembers`,
  `IsGrantable`, `ContractShape`, `Params` and `Method`.
- `currentVersion(contract)`, `currentMembers(contract)`, `versionAt(contract, version)`; `grantedMembers(version,
  granted)`: the members a binding granted `granted` has (shared per version and grant, a `WeakMap` by version);
  `grantIndexes(version, granted)`: the wire's indexes of a grant; `NO_GRANTS`; `takesNoArgs(method)`: whether its
  argument schema is `null`, so references and implementations omit the argument; `MembersImplementation` is a
  shape's members as a type; `memberOrder` (state members, methods and event members, each sorted): the names the
  wire's indexes point into.
- A method's `args.bytes` and `result.bytes`: whether the schema has a `bytes()` leaf, decided once at declaration (a
  link then encodes the method's values with byte segments).
- `kindParams(kind)`: a declared host kind's `ParamsData` (a route checks addresses with it).
- `NORMAL_FORM_VERSION`: changing the normal form changes it and the fingerprints; it is a link-protocol change.
  Fingerprints are a portable hash, not a security boundary. Each member is a node of its kind (`{ state }`, `{ args,
  result }`, `{ keyed }`, `{ event }`): a contract without keyed or event members keeps its fingerprint.
- Nothing in L1 is frozen: Chord-owned data is immutable by convention.
