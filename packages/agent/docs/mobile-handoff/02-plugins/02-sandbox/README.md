# Facet sandbox — isolated-vm

**Unmodified pi facet code running in a V8 isolate with no ambient authority.**
Full JIT, so ~1.8× native rather than the 8–17× a WASM interpreter costs.

```bash
npm install
npm run demo     # a facet: contributions, components, commands, callbacks
npm run audit    # escape audit — the interesting one
npm run bench    # crossing cost, isolate cost, 300 components
npm test         # 412 property assertions
```

Node 22+ (`--experimental-strip-types`). See `../facet-sandbox-poc` for the
QuickJS-WASM equivalent.

## The safety claim, and why it is structural

isolated-vm **can** be used unsafely, and that is what `facets.md` §14.2 objected
to. The footgun is handing the guest a live handle to a host object — via
`derefInto()`, or by returning a `Reference` from a host call — after which the
guest walks that object's prototype chain into the host realm.

This membrane makes that impossible **by construction, not by care**:

1. `encode()` is the only way a host value reaches the guest, and it is
   `JSON.stringify` with a replacer. **Its output is a string.** A string cannot
   carry a reference.
2. Host callables never cross. They become an integer id into `hostTable`, which
   lives entirely host-side. The guest receives a **number**.
3. Exactly **one** `Reference` is ever given to the guest — `__invokeRef`, the
   single call-in point.
4. `derefInto()` is used exactly once, on the guest's **own** global. No host
   object is ever its argument.

The guest's entire view of the host is `{ number, string }`. There is no object
graph, so there is nothing to walk.

### Audit results (`npm run audit`)

```
Ambient authority:
  require / process / fetch          ["undefined","undefined","undefined"]
  global names visible               64 globals

Classic escape ladders:
  Function('return process')()       undefined
  constructor walk on host data      undefined

The isolated-vm Reference footgun:
  __invokeRef.deref()                blocked: TypeError   ("Cannot dereference
                                     this from current isolate")
  __invokeRef.copySync()             blocked: TypeError
  __invokeRef.getSync('constructor') blocked: TypeError
  derefInto() is callable?           inert (object)
  invoke derefInto() result          blocked: TypeError
  host globals via derefInto()       no host globals

Resource bounds:
  spinning guest interrupted         after 205ms
  isolate usable afterwards          true
```

One probe gave a **false positive** in a first draft: testing `f.deref === undefined`
to prove a returned host function is a Proxy rather than a Reference. The
membrane's proxy returns a proxy for *every* property, so `f.deref` is truthy.
That is not a leak — calling it routes to `hostFn["deref"]`, which does not exist
and throws host-side. The audit now calls it instead of checking for absence.

## Performance

| | isolated-vm | QuickJS | native |
| --- | --- | --- | --- |
| 300 markdown components, small | **70 ms** | 494 ms | ~40 ms |
| 300 markdown components, typical | **108 ms** | 1118 ms | 64 ms |
| 300 markdown components, large | **419 ms** | 4260 ms | ~150 ms |
| 146 KB bundle load | **35 ms** | 104 ms | — |
| membrane crossing | **4.5 µs** | 7–17 µs | — |
| per compartment | 1080 KB, 5.5 ms | **77 KB, 0.8 ms** | — |

**~1.8× native at typical size.** QuickJS is 8–17× and gets worse with input size.

Isolates cost **14× more memory than a QuickJS runtime** (1080 KB vs 77 KB) and
are slower to create. For a handful of facets that is irrelevant; for hundreds it
would not be.

`Intl.Segmenter` **exists** here, which is the single hard blocker for reusing
`packages/tui` components under QuickJS. That alone may decide it.

## Limitations

**Budgets do not nest.** A timeout bounds one `evalSync`. A guest function
re-entered *by the host* — a contributed callback, a component method — gets
`callGuestRef`'s own budget, not the outer one. Asserted explicitly in
`property-test.ts`; a runaway callback took 5005 ms under an outer budget of 50 ms.
Bounding total facet time needs separate accounting.

**Async is a settle-callback, not a native promise.** `applySync` is synchronous,
so a host Promise cannot cross. The host returns a token, the guest builds a real
Promise against it, and the host settles it by calling back in. Verified: two
sequential guest `await`s while the host event loop ticked 22 times.

**Native addon, and the ABI matrix is real.** `isolated-vm` ships prebuilds and
only falls back to `node-gyp rebuild` when none matches — which is why install
takes a second, not an hour. It is **not** building V8; V8 is already in the Node
binary. But coverage is narrow:

| version | engines | prebuilds |
| --- | --- | --- |
| **6.2.0** | `>=22.0.0` | linux-x64/arm64, darwin-arm64, win32-x64 — abi127, abi137 |
| 7.0.1 | `>=24.0.0` | — |
| 7.0.0 | `>=26.0.0` | — |

darwin-**x64** is absent everywhere. Installing `isolated-vm@7` on Node 22 falls
through to a source build and **fails without Python and a C++ toolchain** —
verified here. Note also that 6.2.0 is `latest` on npm despite 7.0.1 existing,
because it published one day later.

The project is **not abandonware** — 6.0.1 (Jul 2025) through 7.0.1 (Aug 2026),
actively released. §14.2's "maintenance mode" claim is out of date and should be
corrected. The real risk is different: adopting it couples your minimum Node
version to theirs, and they dropped Node 20 in 6.x and Node 22 in 7.x within a
year. Shipping SEA builds moves that from every user's install to your CI.

**Memory: references release, but lazily.** The `WeakRef` + `FinalizationRegistry`
interning table ports unchanged from the QuickJS membrane and works — 20 000
crossings went to **0 live refs**. But finalization is not prompt: 5 000 refs were
still live 200 ms after a forced GC. Under sustained churn refs accumulate faster
than the collector reclaims them, and a 32 MB isolate did hit its limit.

The consequence is an API rule, not a membrane fix: **do not create references in
a hot path.** `slots.claim(factory)` at construct is one reference forever; a
component method returning a fresh closure every frame is one per frame.

**Hitting `memoryLimit` kills the facet cleanly.** It throws a catchable
`"Isolate was disposed during execution due to memory limit"` and the host
survives — but the isolate is dead and unrecoverable, so teardown must tolerate
an already-disposed isolate. `dispose()` on it throws `"Isolate is already
disposed"`; the membrane guards this.

> **Do not call `isolate.getHeapStatisticsSync()` on a stressed isolate.** It
> **aborted the whole process** during testing — a hard crash, not an exception.
> A `heapMB()` helper was removed from the membrane rather than shipped.

**Still one process, one engine.** A separate isolate is a far stronger boundary
than SES, but Figma's argument for QuickJS was that a *different VM* cannot
confuse objects because the representations differ. Here the guarantee is V8's
isolate boundary plus the membrane's discipline — strong, and structurally
enforced above, but not the same category of claim.

## Files

- `src/membrane.ts` — the membrane. The safety argument is in the header comment.
- `src/facet-example.js` — unmodified facet code: `ctx.use()`, `slots.claim()`
  with a closure, a class instance returned to the host, a subscribe callback.
- `src/demo-facet.ts` — loads it and exercises four boundary crossings.
- `src/escape-audit.ts` — the audit above.
- `src/property-test.ts` — 412 assertions: random `JsonValue` round-trips both
  directions, identity across crossings, callables, error propagation, reference
  release under GC, prototype pollution both ways, budgets, async, disposal.
- `src/bench.ts` — the numbers above.
- `src/markdown-bundle.js` — the real pi `Markdown` component, esbuild-bundled.
