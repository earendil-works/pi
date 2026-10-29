# L1: data and contracts (spec)

Status: **approved (owner, 2026-10-22)**, rewritten 2026-10-22 as the single source for a from-scratch implementation
(the first implementation was discarded for code quality). Every rule here is decided; the decision log
(`packages/chord/docs/next/decisions.md`) has the reasons. Code style: the section "Chord v2 Code Style" of the root
`AGENTS.md`.

## What L1 is

Everything about **data** that the upper layers need and that does not depend on hosts, objects or links: how an
object type is declared and evolves (contracts), what a value is, how params become an identity, how arguments are
checked, what a principal key is, what an error is. Pure functions, types and weak caches; no I/O.

Source: `packages/chord/src/next/contracts/` (declarations) and `packages/chord/src/next/data/` (per-call checks,
principals, errors), split into files by concept. Everything else under `src/next/` is the frozen old kernel: never
imported, never edited. Reused: `src/context/` (`Context`, `BACKGROUND_CONTEXT`, `context.telemetry`) and
`src/json.ts` (`JsonValue`), both unchanged. Schemas are TypeBox 1.3 (`typebox` in `node_modules`).

## 1. Values

```ts
type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value };
```

- JSON plus byte leaves. No `undefined` inside values, no non-finite numbers, no foreign prototypes, no accessors.
- Values from links are already strict JSON plus bytes; values from same-host code are plain data **by convention**,
  immutable once handed over. L1 never walks, copies or freezes a value to enforce that. State is never checked.
- `canonicalJson(value: JsonValue, context)`: sorted object keys, `-0` written as `0`. Used only for principal and
  revocation keys, which are JSON (no bytes), so it lives with principals.

## 2. Contracts: declarations

A contract is the declared type of an object: name, kind, version, params, members. Two kinds:

```ts
const Notes = remote("notes", {
  version: 1,
  params: { session: str() },
  variants: {
    editor: { state: { notes: arr(Note) }, methods: { add: method(obj({ text: str() }), str()), clear: method() } },
    reader: { state: { notes: arr(PublicNote) } },
  },
});
const Info = local("app.session-info", {
  version: 1,
  params: {},
  members: { init: obj({ title: str() }), clear: method() },   // a schema is state, method(...) is a method
});
```

- `remote` has variants (per-principal views, at least one); `local` has one flat `members` map and no variants.
- `method()`, `method(args)`, `method(args, result)`, `method(undefined, result)`. An omitted side is `null` on the
  wire: a no-argument method is called with `null`.
- **Variants (D11):** a member name has the same kind (state or method) in every variant that has it; a method has the
  same signature (args and result) in every variant; state schemas may differ per variant (redaction). Enforced in the
  types of `remote(...)` and at declaration (for untyped callers).
- **Closed argument objects (Q12):** every object schema inside a method's arguments sets
  `additionalProperties: false`, nested ones included, raw `Type.Object` included; record schemas (`map`) are allowed.
  Checked once per declared or edited method, at declaration. `obj()` always produces closed objects and cannot be
  opened.
- Declaration checks (the types cannot express them for JavaScript callers): nonempty name, version a positive safe
  integer, no unknown declaration keys, params policy (section 4), D11, closed arguments, the schema vocabulary
  (below). Each fails with an `Error` naming the path (`notes.editor.methods.add.args`).
- Declarations are immutable by convention: a contract holds Chord-owned snapshots of its schemas (copied once at
  declaration, so later changes to the app's schema objects cannot desync validation from the fingerprint), never the
  app's schema objects. Nothing in L1 is frozen (owner, 2026-10-22). Contracts are branded: hand-built or spread copies are refused by `evolve`, `checkAccepts`
  and `bindProvider` (a private `WeakMap` from contract to its data).
- **Placement** is not part of L1 contracts: the `placement` field arrives with host kinds (L7) and is never part of
  the fingerprint.

### Schema helpers

`str({ min, max, pattern })`, `num({ min, max })`, `int({ min, max })`, `bool()`, `nul()`, `lit(v)`, `oneOf(...literals)`,
`union([...])`, `obj(props)`, `arr(items, { min, max })`, `map(value)` (string-keyed record), `opt(schema)`,
`bytes({ min, max })`, `unknown()`, and `type Static`. They return ordinary TypeBox schemas, so `Static` and TypeBox's
compiler work unchanged. `min`/`max` mean string length, numeric bounds or array length.

`bytes()` is a `Uint8Array` leaf with optional length bounds, checked by `instanceof` and length, never enumerated.
Its enumerable form is the data marker `{ type: "bytes", minLength?, maxLength? }`; the TypeBox check is attached
non-enumerably and rebuilt from the marker whenever a schema is snapshotted, so no callback is ever copied from app
data.

**Vocabulary (rejected at declaration otherwise):** data primitives, arrays and tuples, objects and records, unions and
intersections, `$defs`/`$ref` (use `$ref` for recursion), constraints (`pattern`, `format`, bounds, `multipleOf`,
`uniqueItems`, property counts), `default`, `readOnly`/`writeOnly`, annotations, bytes. Rejected: conditional and
dependent schemas, `not`, `contains`, `propertyNames`, `unevaluated*`, `contentSchema`, `definitions`, unknown
keywords, TypeBox's executable features (`Unsafe` other than bytes, refinements, transforms), accessors, symbol keys,
cyclic objects, non-JSON data.

### Fingerprint

Every version gets a fingerprint at declaration: `hash64` (a portable 64-bit hash, two FNV-style lanes, 16 hex
characters; not a security boundary) of `JSON.stringify({ normalFormVersion, value })` over a **normal form**:

- object keys sorted; `required` and `enum` sorted; union, intersection and tuple order **kept** (it is meaning);
- annotations dropped on schema nodes only (`title`, `description`, `examples`, `$comment`, `deprecated`); defaults,
  formats, patterns, bounds and `additionalProperties` kept;
- params as ordered `[fieldName, schema]` pairs (declaration order is identity order); members as sorted dictionaries;
- `{ kind: "remote", params, variants }` or `{ kind: "local", params, members }`; placement excluded.

`NORMAL_FORM_VERSION = 2` is exported; changing the normal form changes it and is a link-protocol change.
One schema-aware walk produces both the snapshot and the normal form.

### Evolution (Q10)

A history starts with a base written in full (`remote()`/`local()` with an explicit version). `evolve(prev, (e) =>
e...)` appends the next version (`prev.version + 1`) with structured edits:

| Edit | Meaning |
| --- | --- |
| `state(variant, name, schema)` | change one state member (local: `state(name, schema)`) |
| `addState(variant, name, schema)` | add a state member |
| `removeState(variant, name)` | remove a state member |
| `args(name, schema)`, `result(name, schema)` | change one side of a method in every variant that has it |
| `method(name, args, result)` | replace both sides |
| `addMethod(variant, name, args, result)` | add a method (local: no variant); to another variant only with the same signature |
| `removeMethod(name)` | remove a method from every variant |

- Params and the variant set never change by evolution. A change to either is a **new history base**: a new full
  declaration with an explicit version and no accepted older versions.
- A member's kind never changes, also not after a removal and re-add. Checks run after every edit.
- `evolve` must return the builder it was given (no foreign builders). Every version is materialized and
  fingerprinted at declaration, so an old plugin's copy of v1 has the same fingerprint as the history's v1.
- The types track the whole history: `Contract` carries the version, the current description and every step with its
  edits, so `checkAccepts` can require exactly the right mappings at compile time.

### Accepted versions and mappings

A provider may accept older versions of its contract with mappings it owns:

```ts
const NotesV2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(NoteV2)).args("add", NoteV2));
const accepts = {
  1: {
    state: { editor: { notes: (current) => current.map(toV1) } },   // current member -> old member
    methods: { add: { args: (old) => toV2(old) } },                  // old args -> current args
  },
};
checkAccepts(NotesV2, accepts);   // { versions: [{ version: 1, fingerprint }] }
```

`checkAccepts(contract, accepts)` is pure: it validates the table without calling any mapping and returns the accepted
versions with their fingerprints. Mappings are **direct** (old to current, never chained). For accepted version `v`,
considering every edit after `v`, a mapping is required exactly for:

- a changed state member: `(currentMember) => oldMember`;
- a removed state member: `(currentVariantState) => oldMember` (the whole current state of that variant), or
  `"refuse"`;
- a method whose args changed: `{ args: (old) => current }`; whose result changed: `{ result: (current) => old }`;
  both: both functions;
- a removed method (from any variant that had it in `v`): `{ call: async (oldArgs, context) => oldResult }` or
  `"refuse"`; `call` and `"refuse"` are also allowed for changed methods.

Added members need nothing. No-op edits and changes made and reverted still require (identity) mappings: the check is
by edit, not by schema comparison. Unknown versions, the current version, missing mappings, unnecessary keys and wrong
shapes fail at declaration with the path (`notes accepts[1].methods.add`). An absent `state` or `methods` section means
empty and is allowed only when nothing is required there. The same rules hold at the type level (`AcceptsTable`).

`Implementation<typeof Contract>` derives the provider's shape: per variant, state getters `() => value`; methods
`(args, context) => Promise<result>`.

## 3. Principals

- The app's principal type `P` is plain JSON with a `kind` field: no schema, no version, never persisted by Chord
  (objects persist their own projection, e.g. chat's `Author`).
- `principalKey(principal, context, customKey?)`: default `canonicalJson(principal)`; an app may pass its own key
  function, which must be the same on every host. Cached per principal object in `WeakMap`s; a custom key function's
  cache is keyed by the function too, so a dropped function is never retained by a live principal.
- `revocationKeys(principal, revokedBy, context)`: the canonical JSON of each JSON value `revokedBy(principal)`
  returns (`host.revoke` is L7).

## 4. Params and identity

```ts
const { params, key } = checkParams(Notes, { session: "S1" }, context);   // throws invalid/params
const identity = identityKey(Notes, key, principalKey(principal));       // "notes|S1|<principal key>"
```

- Declaration policy: params are a flat record of required fields, each `str()`, `int()`, `bool()` or a union of
  string literals (`oneOf("chat", "agent")`), constraints allowed; no defaults, optional, nested, bytes, numbers other
  than integers. Checked in the types and at declaration.
- `checkParams(contract, raw, context)`: one compiled closed-object check of `raw` (constraints enforced), the compiled
  validator cached per contract in a `WeakMap`. Then the key is the field values in declared order, each escaped
  (`\` and `|`), joined with `|`. It returns the caller's own object: no pre-check walk, no copy, no freeze.
- `identityKey(contract, key, principalKey)`: `name|key|principalKey`, each part escaped; `local` takes no principal
  key (by type). The key is an in-process map key; links carry the params themselves.

## 5. Arguments

```ts
const provider = bindProvider(NotesV2, accepts);                 // once per registration and reload
const checked = checkArgs(provider, "add", raw, boundVersion, ctx); // invalid/args with path
// { kind: "method"; args (current shape); result?: (current) => old } | { kind: "call"; args (old shape); call }
checkArgs(provider, "clear", null, 2, ctx);                         // no-argument methods take null
```

- `bindProvider(contract, accepts)` runs `checkAccepts` once and keeps the app's accepts table as it is (immutable by
  convention; no copy, no freeze). It builds a private dispatch table, held in a `WeakMap` keyed by the returned
  provider: accepted version -> method -> `{ schema, validator, mapping }`. Validators compile on first use per
  (version, method); a weak cache keyed by schema object lets equal schema objects share a compiled validator.
- `checkArgs(provider, method, raw, boundVersion, context)`: three map lookups, one compiled check against the
  provider's schema for that version, then at most one direct `args` mapping old -> current. It returns a tagged
  value (owner, 2026-10-22): `{ kind: "method"; args; result? }` (args in the current shape; `result` maps the current
  result back for an old-version caller) or `{ kind: "call"; args; call }` (a replaced method: the checked old args
  and the provider's `call`, which L4 invokes). Current-version calls are never mapped. Unknown method:
  `invalid/member`. Version not accepted, or `"refuse"`: `contract_mismatch`. Mapping output is trusted.
- Every caller is checked, `local` included (Q15). Unknown fields fail (closed schemas); nothing is stripped, copied,
  frozen or defaulted. Results and state are never checked.
- Memory: a binding lives as long as its registration and the calls in flight. No module-level strong cache holds a
  contract, binding, schema or validator.
- TypeBox keeps its last build in module-level accumulators: after every `Compile`, reset them (`ResetFunctions`,
  `ResetExternal`, in `finally`), so no build state is retained.

### A failed check

A failed compiled check uses TypeBox's public `Errors(schema, value)` and reports the first error. The error is
`invalid/args` or `invalid/params`, message `args/text: <TypeBox's message>` (fixed text for the two common cases:
`args/extra: unknown field`, `args/text: missing`), `details: { path }` with TypeBox's
instance path (`/text`, `/` for the root), including missing (`required`) and unknown (`additionalProperties`)
fields at their own path. TypeBox does not escape `/` and `~` inside keys, so a key containing them makes the path
ambiguous (owner, 2026-10-22: accepted; it is a diagnostic).

## 6. Errors

```ts
type ChordErrorCode = "invalid" | "contract_mismatch" | "forbidden" | "gone" | "not_ready" | "released"
  | "too_large" | "unavailable" | "aborted";
```

| Code | Reasons |
| --- | --- |
| `invalid` | required: `args`, `params`, `member`, `placement`, `reentrant`, `read_after_bulk`, `cycle` |
| `contract_mismatch` | optional: `updating` |
| `unavailable` | optional: `locked`, `park_timeout` |
| `too_large` | optional: `part` |
| others | none |

- One `ChordError` class (an `Error`), with `code`, `reason`, `message`, `details?: JsonValue`. The constructor,
  instances and JSON form are tagged unions: a wrong pairing is a type error, and narrowing on `code` narrows
  `reason`. `toJSON()` emits `{ code, reason?, message, details? }`; stack and cause never cross the wire.
- `PROTOCOL_VERSION = 1` is exported. Reasons and pairings are link protocol: adding or moving one bumps it. A test
  pins the table together with the version and fails with "bump PROTOCOL_VERSION" when they diverge. L6 compares the
  version in the handshake before accepting anything.
- `chordErrorFromJson(raw)`: `raw` is fresh JSON from the link decoder (a trust boundary). Checks the envelope only:
  known code, a reason allowed for that code (required for `invalid`), string message, no other keys. `details` is
  kept by reference: no walk, no copy, no counters.
- Helpers: `isChordError(error, code?)`, `invalid(reason, message, details?)`, `asChordError(error, label)` (wraps a
  foreign error as `unavailable`).
- `FailureCause = { kind: "transient"; error } | { kind: "broken"; error }`: the failing stage decides, never the
  error code. `broken(cause)` marks an open's failure as broken (bad configuration); `openFailure(cause, label)` turns
  an open's thrown value into the cause. Used by L4.
- Plugin errors have their own shape (L4); they never use Chord reasons.

## Cost per hop

| Hop | Work |
| --- | --- |
| a `get` | one compiled closed-object check, one joined key; no walk, no copy |
| a call | three map lookups, one compiled check, at most one direct mapping; no copy |
| first `get` of a contract | one compilation |
| first call per accepted version and method | one compilation (or a cache hit by schema object) |
| a failed check | one counted diagnostic walk (`Errors` builds the whole list on this rare path) |
| a first default principal key, a revocation key | one canonical walk |
| declaration | snapshot, closure check per method, fingerprint per version |
| binding | `checkAccepts` once, dispatch table built, nothing compiled |
| a state change | nothing in L1 |

**Counters:** `chord.data.walks`, `chord.data.validations`, `chord.data.compilations` are telemetry counters
(`context.telemetry.metrics?.counter(name).add(1)`), always on. The function doing the work counts it; call sites never
count for others. Tests assert them per hop with the in-memory telemetry adapter.

## Footguns

- A provider must not mutate arguments or params it received (caller-owned, immutable by convention).
- `principalKey` must be the same function on every host; a different one splits identities silently.
- Params keys must escape the separator, so two different params never join to one key.
- Mappings are direct: when version 3 arrives, every still-accepted version's mappings are updated (compose step
  functions: `(old) => v2to3(v1to2(old))`).

## Tests (one group per mechanism, every case)

- Contracts: every declaration check with its error path; D11 (kind and signature across variants, at runtime and
  in the types); closed arguments (nested, raw `Type.Object`, records allowed, edits checked, state not checked);
  schema vocabulary (each rejected feature); bytes (marker, bounds, check rebuilt after snapshot, no callback copied);
  snapshots are independent of later changes to the app's schema objects; branding (spread copies refused).
- Fingerprints: stable across key order and annotations; sensitive to defaults, bounds, union order, params order,
  `additionalProperties`; the same v1 from a separate declaration; local vs remote differ; a fixed known hash for one
  fixed contract (protects the normal form).
- Evolution: each edit; kind changes refused (also remove then re-add); params and variant set fixed; new bases;
  long chains (versions beyond 9, 99); history types.
- Accepts: every required-mapping rule above, at runtime and at the type level (`@ts-expect-error` for missing,
  unnecessary and wrongly typed mappings); `"refuse"`; `call`; direct mapping over several versions; no mapping is
  invoked by `checkAccepts`.
- Params: missing, extra and wrong fields with their paths; literal membership; constraints; the same key whatever
  the property order; separator escaping (no two params join to one key); declaration refusals.
- Arguments: unknown fields (nested too); no copy (identity of the passed object); `local` and `remote`; bytes by
  `instanceof` and length; old version checked with the old schema then mapped; current never mapped; `null` for
  no-argument methods; unknown method; unaccepted version; `"refuse"`; lazy compilation (counted once per version and
  method).
- Principals: default key, custom key, caching (no second walk), revocation keys.
- Errors: tagged union in types (`@ts-expect-error` for wrong pairings); JSON round trip; envelope checks (each
  refusal); details kept by reference; the pinned protocol table; `FailureCause`, `broken`, `openFailure`.
- Cost guards: the counters per hop in the table above.
- GC: dropped contracts, bindings, dispatch tables, mappings, schemas and validators are collected after the last call
  settles; params validators per contract; custom principal-key functions dropped while their principals live; nothing
  retained by TypeBox's build accumulators.

## Size

Target: well below 1,500 source lines for `contracts/` and `data/` together, tests excluded. The type-level history
and mapping types are the heaviest part; keep the rest lean.
