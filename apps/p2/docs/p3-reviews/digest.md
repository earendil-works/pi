# Digest — native-object code-change detection review

## Status and scope

This records the findings, review points, questions and recommendations produced by the `digest` subagent in this conversation. No implementation changes were made. Experiments were written under `/tmp/digest-exp/`. The functionality map is not included.

**Owner-supplied design assumptions (decided for this review):**

- Natives (sockets, processes, databases, watchers, sandboxes and class instances wrapping them) may only be held by objects, through `self.open(async open, close)` in the object's factory. The value never changes during the object's life.
- Facets are pure objects and may not open natives.
- Factories are synchronous and declare only.
- A plugin reload loads the facet bundle using loader D (one esbuild script per facet), stages facet setup and every live object's new factory with a recording `self`, rolls back if staging throws, and then commits.
- Pure objects swap in place, with new methods and retained documents and references.
- Native objects restart (close, then reopen) only if their code changed.

**Owner proposal, not a confirmed decision:** the native object's digest covers the module containing its factory (described as the `host.serve` call site) plus its transitive imports from esbuild's metafile.

**Existing documented decisions used by the review:** loader D externalizes host packages and `apps/p2/src/**` into the base bundle; base changes cause full host restarts. Plugin graph guardrails prohibit dynamic imports, `require`, top-level await, module-level side effects and raw timers in facets. These are documented target rules, not claims that D is already implemented.

**Still open:** all recommendations below, including `defineNative`, dedicated native modules, lint rules, `codeFiles`, digest manifests and native-holder separation. No owner acceptance of these recommendations was received in this conversation.

The repository inspected still uses `self.resource` and resource versions. Its old resource replacement, dependency propagation and routines are evidence about existing code, not automatically decisions for the new `self.open` model. Where the original response assumed old resource-dependency behavior, that remains an open integration question.

## Original report to the main agent

The following preserves the original report, with its original assertions and estimates. Qualifications and additional review notes follow it.

**Recommendation:** use a digest per native module, not per facet. Each native object type is declared in its own module, `plugins/<p>/native/<name>.ts`, with `export const X = defineNative(Type, factory, opts)`, and the facet only calls `host.serve(X)`. The digest is that module's import closure taken from the esbuild metafile. The proposal as written (the module with the `host.serve` call site plus its imports) is correct today, but in every real plugin it restarts on any facet change.

### 1. Mechanics (measured)

I bundled real facets in `/tmp/digest-exp/build.mjs`. `src/**` and bare packages were external. I used Node 24 because Node 26 on slayer is missing `libatomic`.

- **The data:** `metafile.inputs[path].imports[]` gives `{path, kind, external}`. Internal edges form the graph, and a module's closure is a depth-first walk from it. The digest is sha256 over the sorted `(path, contentHash)` pairs of that closure.
- **Type-only imports are erased.** `radius/contract.ts` does `import type { RadiusBrain }` and has no edge in the metafile, so type-only imports never cause a restart.
- **Build cost:** radius/server.ts 15.8 ms, terminals/server.ts 7.0 ms, codemode/worker.ts 5.5 ms. Loader D runs this build anyway.
- **Closure and hashing cost:** 0.2–0.5 ms per facet.
- **Closures today:**
  - `radius/server.ts`: 5 of 5 bundled files (brain, relay-access, contract, ports/contract).
  - `terminals/server.ts`: 6 of 6 (including `sessions/contract.ts`).
  - `codemode/worker.ts`: 4 of 4 (including `models/contract.ts`).

  The factory's module is the facet entry, so its closure is the whole facet bundle. Here the proposal is the same as the coarse rule.

**Where the digest is stored:**
- The server computes it at build time and ships it in the facet manifest: `{facetDigest, natives: {modulePath: digest}}`. The revision already lists every facet with its digest (target-design §15).
- `defineNative` gets its module path injected by the bundler, the same way loader D injects `import.meta.url` (B4).
- Each host keeps the digest a live native object was opened with in memory. Natives do not survive a host restart, so nothing needs persisting.
- In staging, the recording `self` marks which objects call `self.open`. Commit restarts those whose recorded digest is not the new one.

**Base bundle:** exclude host packages and `src/**`. A base change already restarts the affected hosts (§14.2). Do include the loader version and esbuild options, because a different build changes code without changing any source.

### 2. Correctness: how behaviour can change without the digest changing

| Way it can change | Matters? | Digest | Prevention |
|---|---|---|---|
| Closure over facet-level variables or functions | yes | caught only if the factory's module is the facet, which is coarse | `defineNative` must be top-level in a `native/` module; lint forbids `self.open` outside `native/` |
| Values passed in from the facet (`serveRadius(host, {onStatus})`) | yes | missed by a declaration-module digest | `defineNative` takes no facet arguments, and the facet calls `host.serve(X)` with nothing else (lint) |
| Registries and host values | only if captured in `open` | not code | read them at use through readables; capturing an entry in `open` keeps it stale. Hard to lint, so document it |
| References to other objects (`self.get`) | no | n/a | they are contract-versioned calls; deps already reopen on change |
| Dynamic `import()` | yes | string literals appear in the metafile as `dynamic-import`; computed paths are missed | already forbidden by the §14.5 static check |
| Shared helpers and cross-plugin files | yes | caught (they are bundled) | false positives only |
| Bundled `node_modules` (global plugins) | yes | caught; hashes cached by mtime and size | — |
| External host packages and `src/**` | yes | not counted | covered by the base restart |
| JSON and `?url` assets | yes | caught (they are metafile inputs) | — |
| Files read or spawned via `import.meta.url` | yes | **missed** | see below |
| Runtime config (`radius.json`, `P2_RADIUS`, env file) | data, not code | n/a | watch it, or use `retryOn`/deps |
| Module-level state in a native module | yes | n/a | lint: no top-level mutable state in `native/` |

**Out-of-bundle files:** `terminals/detached.ts` spawns `main.ts` and the ghostty wasm, which never enter the server graph. It already keeps its own hand-written list in `terminalHostVersion()`, and that list can drift. Generate it from a metafile instead, or let `defineNative({ codeFiles })` add those files to the digest.

**Module-level state:** a kept native keeps running old-generation code. After a reload, the bundle is re-evaluated, so new pure code sees fresh module state while the native's callbacks see the old state. An example is `models/worker.ts` `settingsSources` (a top-level WeakMap). The same split breaks `instanceof` against a kept native's class, so lint that too.

**GC note:** esbuild puts all of a facet's modules in one scope. A kept native therefore pins its opening generation's whole script, but only that one generation, so the alive set does not grow over reloads. The leak detector should expect it.

### 3. Granularity: plugins and how often digests would change

Commit counts are for the facet closure versus the hypothetical native-only closure. Caveat: the git history covers only Oct 9–16 (65 commits, mostly a migration). The ratio is the useful signal.

| Plugin | Native module(s) | Facet vs native commits | Cost of a restart |
|---|---|---|---|
| radius | `native/connection.ts`: `RadiusBrain` + `RelayAccess` (brain.ts, relay-access.ts). The `RequestResolvers` logic moves to a pure object | 11 vs 4 | drops the relay WebSocket, including the phone's own connection |
| terminals | `native/service.ts` (service, detached, protocol) plus the per-session view lease; `codeFiles` = the `terminalHostVersion` list | 14 vs 5 | terminal WebSockets drop; detached hosts survive |
| codemode | `native/sandbox.ts` (`CodemodeSandbox` is a host package) + calls.ts. Extension wiring stays pure | 11 vs 1 | kills running scripts |
| workspace (worker) | `native/watch.ts`: only the watch. `writer` is plain state; `viewer` is a liveness lease | environment.ts (890 lines) changed 6×; split watch from file logic | cheap re-watch |
| envs | `native/store.ts` (Observer) and `native/ssh.ts` (manager, remote-env, config) | 15 vs 2 | SSH connections close |
| models (server + worker) | today `openResources` pulls in model-config and provider-config parsing | 16 vs 9 (`model-config.ts` alone changed 18× since April) | low (file watcher) |
| search | `native/db.ts` (SQLite) | 13 vs 3 | trivial |
| login | `native/logins.ts` | `logins.ts` 4 | aborts an in-progress login |
| logs | `captureProcessLogs` + timer. The `collect` logic now inside `open` becomes a routine | n/a | cheap |

For models, the rule should be: the native is only the Observer, and parsing becomes a pure derive. That would cut its digest changes to about 1–2. The same pattern applies to logs.

**Layout rules that make the digest useful:**
- Natives stay thin: `open`, `close` and `expose`.
- All logic goes in pure objects that `self.get` the native.
- No other plugins' contracts in a native closure unless it needs them.

### 4. Alternatives

| Option | Correctness | Simplicity | Connection drops while iterating |
|---|---|---|---|
| Call-site module closure (the proposal) | good | needs a call-site locator (stack traces or an AST scan) | every facet edit, so the same as coarse today |
| **Declaration module closure + lints** | good; gaps closed by lint, plus `codeFiles` | one helper, one manifest field | only real native-code edits |
| Author-bumped `codeVersion` | bad: a forgotten bump means you reload and still run old code, with no signal | simple | minimal, but untrustworthy |
| Separate natives facet per plugin | same as mine, but all natives of a plugin together | needs a second facet per surface and changes discovery | envs store+ssh and codemode sandbox+calls restart together |
| Factory source text + imports | misses helpers and mutable module state; needs free-variable analysis (re-implementing the bundler) | complex | — |
| Coarse: restart all natives on any reload | correct except out-of-bundle files | simplest | worst: radius drops the phone and codemode kills the script doing the reload |

The rule I recommend has the same cost as the proposal, closes the closure and argument gaps by construction rather than by luck, and cuts restarts about 3–10× for radius, codemode, search and envs. For models and logs the gain comes only after their parsing and polling move out of `open`.

## Additional findings and reasoning produced during the investigation

### Correctness and layout — recommendations still open

- The native-holder object is the restart unit, not merely its socket or its `open` function. If resolver, extension or business logic shares its factory, an edit to that logic restarts the holder as well. Keep native-holder objects small and isolate behavior in pure objects.
- Radius concretely mixes `RadiusBrain`/`RelayAccess` ownership with the `RequestResolvers` contribution. Moving only `brain.ts` is insufficient if the digest still roots at `radius/server.ts`. Put the native declaration in a separate module and put resolver registration in a pure object.
- Codemode similarly mixes sandbox ownership, `RunningCalls`, settings-derived extension enablement and `Extensions` registration. Extension wiring should be replaceable without closing the sandbox.
- A helper such as `serveRadius(host, options)` does not solve closure tracking: facet callbacks or other values passed through `options` can change while the helper's module graph does not. A predeclared native descriptor with no arbitrary facet arguments avoids this hidden dependency.
- A callback created inside the native factory or `open` is covered by that factory's module and imports. The problematic callback is one injected from outside that graph, or fetched from a registry and then retained.
- A registry entry read at open-time can retain another plugin's old function after that plugin changes, without changing the native's digest. Read current registry values at use-time instead. This is a dataflow/lifetime issue, not something the import graph proves absent.
- Host-provided code is trusted base code for this purpose, but changing runtime host values is separate from changing host code. The digest does not establish what runtime values were used to open a connection.
- Bundled shared helpers must remain included. Excluding cross-plugin contracts to reduce churn is unsafe without proving those modules contain only inert declarations: contracts can include real runtime logic. Type-only imports are the safe way to avoid a runtime edge when only types are needed.
- `terminals/server.ts` currently pulls `sessions/contract.ts` into the native digest through Catalog use. A separate service-holder module can avoid some such irrelevant edges; a session-specific holder may still genuinely need Catalog.
- For JSON, text, wasm and other assets, inclusion depends on how the loader resolves and loads them. Assets supplied as esbuild inputs can be hashed; arbitrary runtime filesystem reads cannot. `?url` is a loader convention, not itself an esbuild guarantee.
- Computed imports, `require` and reflective code loading should be rejected rather than guessed at. Loader D already proposes these graph restrictions.
- Runtime configuration is not native code. `radius.json`, `process.env.P2_RADIUS`, env configuration and model settings need their own observation/reconciliation policy. A file digest cannot say whether a changed URL, credential or provider setting should reopen a native.
- The native module and its helper graph should have no mutable module-level state. A kept native runs closures from its opening generation while newly evaluated code has fresh module state; this can silently split caches, callback tables or identity checks.
- The cross-plugin `instanceof` warning also applies within one plugin across reload generations: a native created with the old class is not an instance of the newly evaluated constructor. Treat native references as opaque/structural values rather than testing them against reload-local classes.

### Granularity and false positives — findings and open recommendations

- A module digest is conservative, not semantic equivalence checking. Comments, unrelated exports and unused code in a hashed file can cause restarts even when behavior is unchanged.
- Hashing a whole facet's generated output would introduce further instability from bundler naming and ordering. The investigation favored original module content hashes, with accepted file-level false positives.
- Esbuild's metafile does not give per-factory compiled code or the lexical free-variable graph needed for `factory.toString()` plus imports. Function source text omits helper implementations, captured values and class behavior.
- A separate native facet per plugin is an organizational alternative, but facets themselves still cannot open natives under the owner-supplied rule. Such a facet would declare native objects. It also requires deciding discovery and surface naming, and restarts unrelated native objects together.
- Workspace's writer resource currently contains a WeakMap of workspaces and a serializing tail promise. This is not simply a filesystem watcher; deciding which parts are ordinary object state versus native wrappers is still necessary. The viewer resource is a liveness lease, not a socket or database.
- `workspace/environment.ts` mixes read/write operations and watching in 890 lines. Leaving it whole means any file-operation edit changes the watch digest; a narrow watch module is useful only if it does not import the large mixed module anyway.
- Envs has two natural native boundaries: its file observer (`store.ts`) and SSH/browser manager (`manager.ts`, `remote-env.ts`, config helpers). Their lifetimes and change frequencies differ, so a single plugin-wide native digest is needlessly coarse.
- Models has server and worker resource observers. `resources.ts` imports credentials, model store, model configuration and provider configuration. Merely moving the factory to `native/resources.ts` leaves all this parsing in the closure. Separating observation from parsing is the actual granularity change; the predicted 1–2 changes is an estimate, not a measured refactor.
- Search's `SearchDb` wraps `node:sqlite` and is already a small, isolated implementation module. Reopening it is much cheaper than dropping Radius or codemode.
- Login's `Logins` owns provider login flows. Its dependency on models resources is type-only in `logins.ts`, but the native is created with a live `config.resources` value. Its behavior and lifetime therefore have runtime dependency concerns even when there is no static import edge.
- Logs currently mixes process capture, native timer ownership, snapshot validation, deduplication and file polling in `open`. Separate process capture from collection behavior if retaining the capture across logic edits matters.
- Restart costs differ sharply: Radius disconnects the relay and relayed clients; codemode ends VMs/worker threads and running scripts; terminals disconnect views but do not kill detached host PTYs; SSH-manager restarts close connections; workspace watches, SQLite handles, config observers and log capture are relatively cheap to reopen; login restarts cancel in-progress authentication.

### Terminal out-of-graph evidence

`plugins/terminals/detached.ts` computes `terminalHostVersion()` using this explicit list:

```text
main.ts
log-preload.ts
../../src/runtime/logs.ts
daemon.ts
protocol.ts
detached.ts
envs.ts
ghostty.ts
../../vendor/ghostty/ghostty-vt.wasm
```

It reads these files with `new URL(file, import.meta.url)`. It spawns a process using `../../src/source.ts`, `log-preload.ts` and `main.ts`. These process-entry dependencies are not import edges from the server facet. `service.ts` calls `terminalHostVersion()` while opening a `TerminalView`.

The existing hand-maintained version list is precedent for explicit code dependencies, but its completeness was not audited. A separate esbuild entry for the spawned process, plus explicit binary assets as needed, was suggested as an alternative to maintaining a second hand-written graph. Whether a terminal-holder restart should automatically replace an outdated detached host is a separate policy; detecting a change does not by itself update that other process.

### Metafile, cache and registration mechanics — open implementation details

- Build the import graph once per facet; walk it from each native root. Hash shared module contents once and reuse them. For larger graphs, cache closures or collapse import cycles rather than rereading the same files per object type.
- The experiment used a visited set, so import cycles terminate. Cost is proportional to graph traversal and file bytes hashed; the reported sub-millisecond times are for small graphs, not a package-heavy benchmark.
- Bare host specifiers and externalized `src/**` appear in `imports` with `external: true`, but their implementation files are absent from `inputs`. Their implementation cannot be recovered by traversing the facet metafile.
- Bundled non-host registry packages should be included naturally in `inputs`. Their code changes count. The experiment externalized all bare specifiers as a simplification because the three chosen facets use host packages and builtins; it did not validate a real global plugin with bundled npm dependencies.
- A content hash cache keyed by mtime/size was proposed as a performance optimization. The correctness requirement is still a hash of the bytes actually built; mtime/size alone is not proof of identical content.
- Include build semantics in the digest: at least the bundler/loader version and relevant esbuild options such as defines and target. Source-only hashes miss transformations that change emitted behavior.
- Paths should be stable for the digest rather than checkout-dependent absolute paths. The experiment used metafile paths relative to the repository working directory; canonicalization and relocation rules were not implemented.
- A declaration module is easier to identify reliably than a `host.serve` call site or an arbitrary function's source module. A bundler transform can inject its stable module ID into `defineNative`; stack traces and runtime function inspection were rejected as fragile registration mechanisms.
- Native descriptors should be immutable declarations rather than factories that a facet parameterizes or wraps. Otherwise the source-module ID no longer captures the code or values actually installed.
- Store digest metadata on the declaration/type manifest and the opened object's host record. Do not infer it from function identity across bundle evaluations; every evaluation creates new functions even for unchanged source.
- Excluding base code is valid only because loader D's base changes restart the host. If base hot reload is introduced, include a base revision/digest or define equivalent invalidation.

## Experimental evidence and limitations

### Environment and graph output

- Workspace: `/home/badlogic/pi-private/apps/p2` on slayer.
- Installed esbuild version observed: `0.28.2`.
- Script: `/tmp/digest-exp/build.mjs`; it used `bundle: true`, `write: false`, `format: "cjs"`, `platform: "node"` and `metafile: true`.
- Node was absent from the default PATH. `/home/badlogic/node-v26.11.1-linux-x64/bin/node` failed with `libatomic.so.1: cannot open shared object file`. `/home/badlogic/node-v24.4.1-linux-x64/bin/node` worked (`v24.4.1`).
- The script built radius/server.ts, terminals/server.ts and codemode/worker.ts sequentially. Timings are one run, not statistically controlled measurements or an implementation of the complete loader D wrapper.

Internal graph, with external leaves omitted:

```text
radius/server.ts
  ports/contract.ts
  radius/brain.ts
    radius/relay-access.ts
  radius/contract.ts
  radius/relay-access.ts

terminals/server.ts
  sessions/contract.ts
  terminals/contract.ts
  terminals/service.ts
    terminals/detached.ts
      terminals/protocol.ts
    terminals/protocol.ts

codemode/worker.ts
  models/contract.ts
  codemode/calls.ts
  codemode/contract.ts
```

- `radius/brain.ts` alone had a 2-file internal closure; `terminals/service.ts` had a 3-file closure; `terminals/detached.ts` had a 2-file closure; `codemode/calls.ts` had a 1-file closure.
- Radius external leaves included pi-ai Radius provider/config, `ws`, Node builtins, runtime Chord/server/logs modules, Chord and TypeBox.
- Terminals external leaves included Chord and Chord/node, `ws`, Node builtins, runtime Chord/principals/server modules and TypeBox.
- Codemode external leaves included pi-codemode, Durable/codemode, Durable, Chord/context, runtime worker/durable/Chord modules, Chord and TypeBox.
- The metafile demonstrates static runtime edges and erased type-only imports. It does not establish behavior equivalence, runtime closure freshness, successful native preservation, close/open ordering or GC behavior.

### History evidence

The first history query used `git log --follow` per file; the later aggregate query used ordinary path history without `--follow`. Those are different measurements and should not be mixed. For example, `radius/brain.ts` had 8 followed-history touches, while the ordinary-history union for brain plus relay-access was 4. The original report's aggregate counts were the latter, not a complete historical simulation of restarts.

Individual followed-history counts produced during the investigation:

| Files | Counts |
|---|---|
| radius/server.ts, brain.ts, relay-access.ts, contract.ts | 7, 8, 4, 2 |
| terminals/server.ts, service.ts, detached.ts, protocol.ts, contract.ts, main.ts | 7, 2, 3, 3, 4, 7 |
| codemode/worker.ts, calls.ts, contract.ts | 7, 1, 4 |
| workspace/worker.ts, environment.ts, protocol.ts, contract.ts | 7, 6, 4, 7 |
| envs/server.ts, manager.ts, store.ts, config.ts, remote-env.ts, schema.ts, contract.ts | 9, 3, 1, 2, 3, 1, 5 |
| models/server.ts, worker.ts, config.ts, resources.ts, provider-config.ts, model-config.ts, credentials.ts, model-store.ts, contract.ts | 7, 5, 3, 2, 2, 18, 2, 2, 8 |
| search/server.ts, db.ts, contract.ts | 7, 3, 7 |
| login/server.ts, logins.ts, contract.ts | 8, 4, 6 |
| logs/server.ts, contract.ts | 7, 4 |
| sessions/contract.ts, ports/contract.ts | 9, 5 |

These were queried since April 1, 2026. The non-follow plugin history observed ran from October 9 to October 16, 2026. These counts primarily demonstrate facade/migration churn versus some more stable implementation files; they do not establish an expected future connection-drop frequency.

The aggregate radius, terminals and codemode sets match the measured metafile graphs. Other aggregate sets were hand-selected approximations, not generated full closures, so the original table's 13/3, 15/2 and 16/9 values should not be treated as exact end-to-end digest simulations.

## Qualifications and open questions

These qualify claims in the original report rather than recording new owner decisions.

1. **Static code versus all behavior.** “Correct today” is too broad without the runtime-value and out-of-graph qualifications. A metafile digest detects changes to included code, not every possible behavior change. No source-only rule can account for mutable runtime inputs without an additional lifecycle policy.
2. **Factory location versus registration location.** The question conflates the factory's containing module with the `host.serve` call-site module. Once a factory is imported, these differ. The recommendation intentionally roots at a declared native module, not the importing facet. The API and bundler transform remain unimplemented.
3. **Native-reference dependencies.** The original table says “deps already reopen on change,” based on old `self.resource` semantics. The new model says natives restart only for code changes and their values never change during object life. It remains open how a native holder depending on another native holder is invalidated when the provider restarts, and how old native values or callbacks are prevented from being retained. Contract-versioned method calls do not by themselves solve a captured `config.resources` value or terminal view.
4. **Registry capture lint.** Directly banning known APIs at `open` sites is possible; proving no registry function or host value is indirectly captured is harder. The recommendation does not supply a sound dataflow lint implementation. Decide whether a documented rule is sufficient or whether the native API must restrict such inputs structurally.
5. **Lint reach.** The proposed restrictions need to apply to helper modules in the native closure, not just to the declaration file; otherwise mutable module state or hidden loading can be moved into a helper.
6. **Generation retention.** The original report reasoned that a kept native can retain its old facet generation because esbuild scope-hoists modules. No heap or GC experiment proved that every retained native necessarily pins the whole script, nor that exactly one old generation remains for an entire facet. Several native types can retain different opening generations. This must be measured and reflected in generation-GC tests and the leak detector, not assumed away.
7. **Kept native behavior.** A native wrapping a class instance contains old-generation methods even if new pure objects swap methods. The no-mutable-module-state and no-cross-generation-`instanceof` rules address part of this, but the boundary between thin native wrapper behavior and reloadable pure behavior still needs specification.
8. **Timers, leases and mutable wrappers.** Workspace and logs expose ambiguity about what counts as a native under the new model. Existing resources sometimes hold mutable containers, promises, callbacks, liveness leases or wrappers that replace internal watches during relocation. Their mapping to immutable-lifetime `self.open` values has not been designed here.
9. **Runtime config lifecycle.** `retryOn`, deps and routines are mechanisms from the inspected target docs, not confirmed APIs in the owner's new model. Decide how config-driven reopening happens without mislabeling data changes as code changes.
10. **Assets and separate processes.** Decide between explicit `codeFiles`, separate build entries and another asset-dependency mechanism. A main.ts build may still need explicit wasm/native binary inputs. A digest change in a client-side holder does not guarantee a detached process has adopted new code.
11. **Hash fidelity.** The experiment reread files from disk after esbuild completed. A production implementation should hash the exact inputs used by the build, avoiding an edit-between-build-and-hash race. Loader D build options, source rewrites, resolver choices and injected paths must be covered by the digest scheme.
12. **Manifest identity.** The original sketch keys native digests by module path. One native type per declaration file makes that workable; otherwise metadata also needs a stable declaration/type identity. The host must retain the digest of the code that actually opened the kept native, not merely overwrite it with a newer facet revision.
13. **Rollback boundary.** Staging throws before commit are covered by the owner-supplied rollback rule. Post-commit close/open failures are not made transactional by a digest. This investigation did not settle their readiness, failure, retry or reporting semantics.
14. **How much false-positive reduction is worth it?** The 3–10× claim is illustrative history-based evidence, not a benchmark of a completed split. Native-heavy subsystems such as models can keep changing frequently unless dependencies are reorganized, and comment-only changes still restart them.

## Recommendation, still awaiting owner decision

Adopt **a dedicated declaration module per native object type, with a digest of that module's bundled static import closure**, plus explicit coverage of executable/asset files outside that graph. Keep facets declarative and native holders thin. Do not permit facet-injected callbacks or arbitrary values to silently parameterize an otherwise unchanged native declaration. Keep host/base code external only while base changes require host restart. Store the build-produced digest with the native declaration and the digest actually opened with each live object.

Use static rules to prevent the straightforward hidden dependencies (nested/parameterized declarations, native opens outside allowed modules, dynamic loading and mutable module state), but do not claim lint or a metafile proves runtime behavior equivalence. Specify runtime config changes, provider-native replacement, cross-generation identity and retained-generation accounting separately. The coarse rule is simpler but drops Radius and codemode during unrelated iteration; manual code versions are easy to forget; function-source hashing is not a reliable substitute for an explicit code boundary.
