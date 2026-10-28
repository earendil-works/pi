# contracts

Declarations of Chord object types: what an object's state and methods look like, version by version.

## For apps (`index.ts`)

```ts
import { arr, evolve, hostKind, type Implementation, method, obj, remote, str } from "./index.ts";

export const Session = hostKind("session", { id: str() });   // a kind of addressable host, params like a contract's
const Note = obj({ text: str() });
export const NotesV1 = remote("notes", {
	version: 1,
	params: { session: str() },
	placement: ({ session }) => Session({ id: session }),     // where an object lives; not in the fingerprint
	variants: {
		editor: { state: { notes: arr(Note) }, methods: { add: method(Note, str()), clear: method() } },
		reader: { state: { notes: arr(Note) } },
	},
});
export const Notes = evolve(NotesV1, (e) => e.args("add", obj({ text: str(), tag: str() })));
type NotesProvider = Implementation<typeof Notes>; // { variant: "editor"; members: { notes, add(args, context), clear(context) } } | { variant: "reader"; ... }
```

- `remote(name, { version, params, placement?, variants })`: per-principal variants, each with `state` (schemas) and `methods`
  (`method(args?, result?)`; an omitted side is `null`, and a method whose arguments are `null` omits them:
  `clear(context)`). `local(name, { version, params, members })`: one flat map,
  where a schema is state and `method(...)` a method.
- `placement(params) => Address` (remote only, optional): the address of the host that serves the object for these
  params (`host/`'s routing table). The caller computes it and sends it with its hold, so a relay routes by the address
  alone. It is not part of the normal form or the fingerprint and `evolve` carries it.
- `hostKind(name, params?)`: a kind of addressable host (`Server = hostKind("server")`, `Session = hostKind("session",
  { id: str() })`); `params` follow the params policy below. Calling it makes an `Address { kind, params, key }`, its
  key built like an identity key (`session|S1`); two addresses are equal when their keys are. The params are checked
  where the address is routed or served (`invalid/placement`), not when it is made. No host-name strings in app code.
- Schema helpers: `str`, `num`, `int`, `bool`, `nul`, `lit`, `oneOf`, `union`, `obj`, `arr`, `map`, `opt`, `bytes`,
  `unknown`, and `Static`. They return ordinary TypeBox schemas.
- `evolve(previous, (e) => e...)`: the next version from structured edits (`state`, `addState`, `removeState`, `args`,
  `result`, `method`, `addMethod`, `removeMethod`); it must return the editor it was given.
- Types: `Contract`, `Implementation<C, X>` (what a factory returns: for `local` a `Watchable` per state member and a
  function per method, `(args, context)` or `(context)` without arguments; for `remote` one variant, `{ variant,
  members }`; `X` is the context type the methods get), `ParamsOf<C>`, `AcceptsTable<C>` (the older versions a provider serves, with their mappings),
  `HostKind`, `Address<K>`, `KindShape` and `ParamsOfKind<K>`.

Rules:

- Declarations are checked once and fail with an `Error` naming the path (`notes.editor.methods.add.args`). A contract
  keeps its own copies of its schemas: changing a schema object after declaring it changes nothing.
- A member name has one kind (state or method) in every variant and for the whole history; a method has one
  signature in every variant. State schemas may differ per variant.
- `then`, `release`, `variant`, `state` and `retry` are refused as member names: a reference has them (`then` would
  make an awaited reference thenable).
- `$bytes` is reserved only in the values of a method whose argument or result schema has a `bytes()` leaf: there it
  marks a byte segment on a link (an own key `$bytes` fails `invalid/args` when it crosses one); everywhere else it is
  ordinary data.
- Every object inside a method's arguments is closed (`additionalProperties: false`); `obj()` always is, records
  (`map()`) are allowed.
- Params are required `str()`, `int()`, `bool()` or `oneOf(...)` of strings. Params and the variant set never change by
  evolution: changing them is a new history base, a new declaration with no accepted older versions.
- Mappings in an `AcceptsTable` are direct (old version to current); when a version is added, update every accepted
  version's mappings. A mapping is required per edit after the accepted version, even for a no-op edit.
- Contracts are branded: a spread or hand-built copy is refused everywhere.

## For Chord's layers (`internal.ts`)

- `checkAccepts(contract, accepts)`: validates an accepts table without calling a mapping; returns the accepted
  versions (version and fingerprint).
- `contractData(contract)`: the Chord-owned data behind a handle (its `placement`, its versions with their
  `VariantData`, `MethodData` and schema snapshots, its `ParamsData`); a local contract's members are the variant
  `LOCAL`. Type-level helpers: `ShapeOf`, `CurrentVariants`, `ContractShape`, `Params` and `Method`.
- `currentVariants(contract)`: the current version's variants (a local contract has the one variant `LOCAL`);
  `takesNoArgs(method)`: whether its argument schema is `null`, so references and implementations omit the argument;
  `VariantImplementation` is one variant's members as a type; `variantNames` and `variantOrder`: the names the wire's
  indexes point into.
- A method's `args.bytes` and `result.bytes`: whether the schema has a `bytes()` leaf, decided once at declaration (a
  link then encodes the method's values with byte segments).
- `kindParams(kind)`: a declared host kind's `ParamsData` (a route checks addresses with it).
- `NORMAL_FORM_VERSION`: changing the normal form changes it and the fingerprints; it is a link-protocol change.
  Fingerprints are a portable hash, not a security boundary.
- Nothing in L1 is frozen: Chord-owned data is immutable by convention.
