
# Other Ways to Do It {#compared lede="Cordis and DeepSeek Harness attack the same problem, plugins that come and go while an agent runs, inside one process. What that buys, and what it costs."}

Chord v2 is not the only answer to "replace plugin code while the app keeps running". The closest relative is
**Cordis**, a TypeScript plugin framework by Shigma that has been the plugin kernel of the Koishi chatbot framework
since 2019, and its most visible user, **DeepSeek Harness** (`dsh`), DeepSeek's open-source agent harness, whose
motto is "everything is a plugin". This chapter compares them with Chord v2 on the questions the guide cared about:
who owns side effects, how plugins depend on each other, what a reload keeps, what a crash keeps, and how far the model
reaches beyond one process.

:::note | Sources and status
DeepSeek Harness at commit `687f282` (release 0.2.1-rc.2), which vendors Cordis as `@deepseek-ai/cordis` 4.0.5 (Cordis
RC7 with local changes, `vendor/README.md`): its Cordis tutorial (`docs/cordis-tutorial/`), `docs/architecture.md`,
`docs/subsystems/persistence.md`, `docs/subsystems/core.md` and `packages/boot/hmr/README.md`; the Cordis paper "A
Programming Paradigm for Spatiotemporal Composability" (arXiv 2608.25512). Cordis and dsh are built and in use; Chord v2
is the design this guide describes. The comparison is between a working system and a design.
:::

## Cordis in one example

A Cordis plugin is a function (or an object with `apply`, or a `Service` subclass) that receives a **context**. It may
declare the services it needs with `inject`, and everything it does to the world goes through the context:

```ts
export const name = "greeter";
export const inject = ["tools"];                       // activate only while a `tools` service exists

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({ name: "greet", /* … */ }));   // a registration is an effect: undone on unload
  ctx.on("session/start", (s) => log(s.id));                     // an effect-bound listener
  ctx.effect(() => {                                              // any other side effect, with its disposer
    const timer = setInterval(work, 200);
    return () => clearInterval(timer);
  });
}
```

Each plugin instance is a **fiber** with states `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED` (or `FAILED`).
Every effect, registration, listener, child plugin and provided service is recorded on the fiber, and unloading runs
the disposers. The paper calls this **temporal composability**: a component can be removed at any time and reverses its
own effects. Its counterpart, **spatial composability**, is the dependency side: `inject` is live, so a plugin starts
when its services appear, and unloads (and later reloads) when a service it depends on goes away or is replaced. The
paper's claim is that independently written components can therefore be combined and replaced without disturbing each
other. The next sections check how far that holds.

**Services** are named capabilities on the context (`ctx.provide("x", value)` or `class X extends Service`). Names are
runtime strings in one flat namespace per application; TypeScript declaration merging makes `ctx.x` typecheck, but
nothing checks the service's shape at runtime, and optional dependencies are probed with `ctx.get("x")`. Scopes come
from the context tree: `ctx.extend()` derives a child context, `ctx.isolate(name)` gives one subtree its own binding of
a service, so two parts of an app can use two different `shell` providers.

**Hot reload** follows from the two halves: the reload plugin unloads the old fiber (unwinding all its effects) and
loads the new module with the same config. Nothing held in the old instance's closures or fields survives; a plugin
that needs state across reloads must keep it in a service or on disk. Config edits are diffed by entry id and
mount, unmount or reconfigure only what changed; config fields declared volatile update in place without a remount.

## DeepSeek Harness on Cordis

dsh applies "everything is a plugin" to an agent: the model adapters (`ctx.llm`), the tool registry (`ctx.tools`), the
session log (`ctx.sessions`), the agents (`ctx.agents`) and the agent loop itself (`ctx.agentLoop`) are plugins and
services. A running dsh is a plugin tree composed at boot from a **profile** (`web`, `headless`, `sdk`, `acp`) that
stacks **bundles** of Cordis config rows, with user patches on top. There is no privileged core: replacing the agent
loop is a config patch.

| Concern | How dsh does it |
| --- | --- |
| sessions | a durable, append-only event log per session (JSONL backend, single writer, `flush` as the durability barrier); model history is derived from the events |
| crash mid-turn | the log keeps everything appended; on resume the agent loop closes the open turn by appending missing tool errors and a synthetic `turn/end { reason: "interrupted" }` |
| tools | `ctx.tools.register(defineTool(…))`, an effect of the registering plugin; calls go through pre/execute/post policy waterfalls |
| approval | closed by default; `allowed-once` is the only grant; plugin installation needs full access or per-call approval |
| reload | a source watcher evicts changed modules; Loader entries running affected plugins stop and start again with the new code; a failed replacement is an activation failure, its previous code no longer runs |
| processes | one plugin tree in the Host process; the browser client and Electron's renderer talk to it over RPC streams |
| distribution | a Plugin Manager installs and enables bundles per profile; plugin markets are optional indexes |
| subagents | local subagents with their own durable sessions, and external ones |

## What the guarantees are in practice

Reading the Cordis source vendored in dsh and dsh's own documentation, the guarantees are narrower than the paper's
framing. An earlier review for p2 came to the same result (`apps/p2/docs/p3-reviews/dsh-compare.md`).

- **Reversal is cooperative and unordered.** `_unload` runs all of a fiber's top-level disposers concurrently
  (`Promise.all` in `vendor/cordis/src/fiber.ts`); order holds only inside one effect, and the primer tells authors to
  "keep the related work in one effect" when teardown order matters. A disposer that throws is logged and skipped. A
  disposer that never settles stalls the teardown; dsh's jobs service works around this by force-failing a job whose
  cancel throws and warning that "the work may be orphaned" (`packages/jobs/jobs-local/README.md`). Reversal is as
  good as every disposer, and nothing checks that a plugin registered all its effects.
- **Behaviour depends on registration order, and a reload changes it.** `emit`, `waterfall`, `serial` and `bail`
  listeners run in registration order (`docs/cordis-primer.md`). Registering appends the listener (`push` in
  `vendor/cordis/src/events.ts`, unless `prepend`), so when a plugin reloads, its listeners move to the end of the
  list. A tool-policy listener that ran first runs last after its own plugin reloads; a waterfall that short-circuits
  now sees a different decision first.
- **Dependencies are strings, and every provider reload restarts its dependents.** A fiber's activation key is the
  concatenation of its injected providers' fiber ids (`_refresh` in `fiber.ts`), so replacing a provider unloads and
  reloads every plugin that injects it, with their in-memory state. Service APIs are "pre-stable; update every
  consumer" (`AGENTS.md`): there is no versioned contract between a provider and its consumers.
- **Reloading a core service ends live work.** Unloading the agent provider "stops and drains every live handle it
  made" (`packages/core/agent/README.md`), so running agents stop; reloading the session persistence backend under
  live sessions invalidates their write handles, and "writes fail loudly until the sessions restart"
  (`.agents/notes/implemented/architecture/2026-08-27-handle-based-session-persistence.md`).
- **Registrations leave a gap.** A reloading plugin's tools and other registry entries are removed with its old fiber
  and added again by the new one; anything that looks them up in between does not find them.

None of this is a bug in the narrow sense: each point is documented, and dsh is built around it. But "components
interleave without disturbing each other" holds only for plugins that own nothing other plugins depend on, register
every effect, order nothing by registration, and hold no state that must outlive a reload.

## Side by side

| | Cordis and dsh | Chord v2 |
| --- | --- | --- |
| unit | a plugin instance (fiber) in one context tree | an object per (type, input, principal), placed on a host (chapters II, III) |
| side effects | recorded on the fiber with `ctx.effect` and friends; on unload the disposers run concurrently, each as good as its author made it | declared through `self` (documents, natives, routines, jobs, contributions); Chord activates and undoes them (chapters V, IX to XI) |
| dependencies | service names as strings in one flat namespace, via `inject`; a provider reload restarts every dependent | typed contracts via `get(Type, input)`; a reference parks and recovers through restarts (chapter VI); optional dependencies are registries (chapter XIII) |
| ordering | listeners run in registration order, which changes when a plugin reloads | registries compose with a declared `compose` function; nothing depends on load order (chapter XIII) |
| where code runs | one process; remote UIs over RPC to the Host | a tree of hosts (server, workers, tabs); objects reachable across links, relayed by the server (chapters I, XVII) |
| who is calling | not a framework concept | principals stamped by links, variants per caller, revocation (chapters III, VII) |
| state | the plugin's own business; dsh's session log is a service | documents written in transactions, persisted, versioned and migrated (chapter V) |
| reload | unload the old instance, load the new one: in-memory state and running work of that plugin end | pure objects swap their code in place with their documents and running work kept; only objects with natives restart (chapter XV) |
| a running agent turn during reload | entries of changed plugins stop; unloading the agent provider stops its live agents | the harness is base code; Durable pins tools per task phase, so a running call finishes on old code and the next phase uses the new (chapter XIV) |
| crash recovery of a turn | the turn is closed as `interrupted` | pi-durable continues the turn's tasks from their checkpoints; replay-safe tools rerun (chapter XIV) |
| contracts and versions | TypeScript types only, pre-stable APIs, every consumer updated together; config validated with a schema | contract versions with fingerprints and provider-side mappings for old consumers (chapter XVI) |
| status | in production in Koishi since 2019; dsh released | a design with the contract layer built |

## What the comparison says

**The core idea is the same.** "Factories declare, Chord activates" (chapter II) and Cordis' reversible effects are
two forms of one rule: a plugin may only change the world through its runtime, so the runtime knows what to undo.
Both reject the module-level timer and the stored callback for the same reason.

**The difference is what survives a reload.** Cordis reloads at plugin granularity: the old instance unwinds and the
new one starts from nothing, together with every plugin that depends on it. That is simple, but a plugin's in-memory
state and its dependents' state and work in flight end with it, and correctness rests on every disposer and on
registration order. Chord v2 keeps state out of closures on purpose (documents, references, jobs as
records) so that it can swap the code of a pure object while its data and running work stay, and restarts only what
holds OS handles. That is more machinery: transactions, a store, versions on every document and contract.

**The other difference is reach.** Cordis composes plugins inside one process, and dsh adds RPC to its own clients.
Chord v2 makes the process boundary part of the model: objects live on the host their placement names, callers are
principals, and a reload rolls out across the server, the workers and every tab. An app like p2, with a process per
session and guests in other browsers, needs that; a single-process agent does not.

:::review | Review: what a reload does to a running tool call in dsh
The sources say that Loader entries running affected plugins stop and that unloading the agent provider stops its live
agents (`packages/boot/hmr/README.md`, `docs/subsystems/core.md`). They do not say what happens to a tool call in
flight when only the tool's plugin reloads; the comparison above does not claim either way.
:::
