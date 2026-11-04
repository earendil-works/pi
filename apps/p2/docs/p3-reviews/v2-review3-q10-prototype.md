# Q10 prototype review (contract evolution): Fable and Astra

Prototype reviewed: `/tmp/evolve-proto/evolve.ts`, `evolve.test.ts` (forward evolution: `remote(name, fullV1)`,
`evolve(prev, e => e.state(…).method(…).removeMethod(…).addMethod(…))`, typed `Impl<current>`, `AcceptsTable` keyed by
old version with mappings required at type level from the edit lists, `NoInfer` on `accepts`, runtime materialization,
normal-form fingerprint and completeness check at `serve`). Both verdicts: **the approach works and stays; the
prototype is not adoptable as is.** Chains of 5, 9, 10, 20 versions type-check in 0.11-0.14 s (TS 7) with readable
errors.

## Fable (probes in `/tmp/evolve-probe`)

Proven: type-level required mappings on the hard cases (shared sub-schema stated per member; a method changed in v2 and
removed in v3 needs only `call | "refuse"`; wrong-direction mappings are compile errors); exact old fingerprints by
materialization; the runtime check catches untyped providers by member name.

Holes:
- Members added after v and then edited or removed are wrongly required for v (v4 `addMethod("editor","m4")`, v5
  `method("m4", …)`: `accepts[1]` demands `m4` typed `unknown`; add-then-remove demands `call | "refuse"` for a member
  v1 never saw). Runtime does not require it: type and runtime disagree. Fix: filter edits by membership in the old
  description (`Extract<…, keyof AllMethods<O>>`, also for state and removed).
- Result-only or args-only change over-requires (both `args` and `result` demanded). Fix: runtime requires only the
  changed part; the type keeps the method entry required with `args`/`result` optional per change.
- Changed and changed back (v2 Number, v3 String): the type demands an identity mapping, runtime does not. Harmless;
  document or require `identity`.
- No edits for state add/remove, variant add/remove, input (direction (c) needs `e.input(schema)` = new base, older
  accepts dropped). A removed state member or variant shows only as a runtime "missing mappings … (removed)" with
  nothing the author can write.
- A method cannot be added to a second variant (`addMethod` refuses any existing name across variants).
- D11 unenforced: `remote()` accepts `f: method(String)` in variant a and `f: method(Number)` in b; `Impl` becomes
  `(x: string | number)`.
- Normal form unstable: `required` not sorted (reordering properties changes the fingerprint), `anyOf` order likewise;
  `examples` kept. TypeBox 1.3: `Optional` only through `required`; `Literal` → `const`; `Record` →
  `patternProperties`; `Cyclic` → `$defs/$id/$ref` (renaming `$id` changes it); `Unsafe` → whatever the author wrote.
- Mutation after declaration: schemas shared by reference; mutating one leaves the stored fingerprint stale while the
  completeness check compares the mutated objects.
- JavaScript slip-throughs: `accepts[1].methods.r = "nonsense"` accepted (only `!== undefined` checked); unknown
  mapping keys ignored; a hand-built `Contract` with a forged `history` is trusted by `serve`.

Smallest changes: (1) filter required mappings by membership in the old description; (2) `args`/`result` separately;
(3) add edits `addState`, `removeState` (mapping current → old member or `"refuse"`), `addVariant(name, { as })`,
`removeVariant` (refuse), adding an existing method to another variant, `input(schema)` as a new base; (4) enforce D11
in `remote()` (type and runtime); (5) normal form: sort `required`, `enum`, `anyOf`/`oneOf` by canonical string; drop
`examples`, `$comment`, `deprecated`; keep `default`, `format`, `pattern`, bounds; freeze with the protocol version and
pin TypeBox; (6) deep-copy or deep-freeze schemas into the history; brand `Contract`; (7) runtime shape checks on
`accepts` and reject unknown keys.

## Astra

1. **Blocker:** `normal()` drops `title`, `description` and `~*` everywhere, including property and member
   dictionaries: `Type.Object({ title: Type.String() })` and the Number equivalent have the same fingerprint, and the
   change bypasses mapping completeness. Unsorted `required` gives false mismatches on reordering.
2. **Major:** historical schemas are mutable aliases (see Fable).
3. **Major:** the runtime check tests presence, not validity: state mapping `null` or `42`, changed-method mapping
   `{}`, removed-method mapping `0` pass. Inconsistent method signatures across variants are accepted; `addMethod`
   permits a method with an existing state member's name.
4. **Major:** accumulated edit unions include members the old version never had (V2 adds `temporary`, V3 removes it;
   accepting V1 requires a `temporary` mapping typed `unknown`). Changed → removed and one method in two variants
   work.
5. Gaps: variant `"v.x"` becomes `state.v["x.s"]` (edits encoded as dotted strings); adding an existing method to
   another variant fails with `never`; state removal and variant add/remove are absent and rejected at runtime even
   with mappings; the base version is fixed at 1, so dropping the bottom of the history cannot keep published
   version numbers.
6. Conservative, not unsound: result-only changes require an identity args mapper; no-op edits require identity
   mappings.
7. Scaling fine (5/10/20 versions 0.11-0.14 s); Optional, Union, Literal, Record, named `Cyclic` survive
   fingerprinting; executable refinements via `Unsafe` are silently dropped from fingerprints instead of rejected.

Smallest changes: a schema-aware, data-only normal form (schema nodes vs property dictionaries vs literal data;
reject executable features); immutable schema and history metadata owned at declaration; structured edit records, not
delimiter-encoded strings, with obligations from historical membership and current disposition; runtime validation
of mapping shapes, edit targets, member-kind consistency and shared method signatures; explicit version ids per
history node (rebasing); the missing structural operations, or an explicitly excluded subset.
