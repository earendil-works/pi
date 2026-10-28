
# The Agent {#agent lede="pi-durable inside Chord: the harness as a core object, models, environments and tools through registries, and how a tool reaches Chord objects and people."}

Each Studio worker runs a pi-durable harness for its session. The harness must run for the worker's whole life,
whether anyone watches or not. Its models come from the models plugin, its execution environments from the envs
plugin, its tools from every plugin, and all of those reload independently. This chapter assumes you know pi-durable
and shows only how it plugs into Chord.

## Shared foundations

Durable and Chord v2 share modules: Durable imports Chord's `context`, `delta`, `json`, `output` and `sqlite`, and v2
imports the same, so `Context`, `Draft` and `JsonValue` are one type each. A v2 readable is today's
`replicatedState` (`chord/src/state.ts`), so Durable's `viewState()` and document watches can be exposed as Chord state
members without conversion. Only plain data crosses between Durable and Chord objects.

## The harness is a core object

```ts
// studio/src/core/harness.ts (base code)
import { Harness as DurableHarness } from "@earendil-works/pi-durable";

export const ChordHostKey = createContextKey<Host<P>>("studio.chord-host");
export const HarnessModels = defineRegistry<Models, Models>("studio.harness-models", { version: 1, compose: firstModels });
export const HarnessEnvironments = defineRegistry<EnvFactory, EnvFactory>("studio.harness-envs", { version: 1, compose: firstEnv });
export const HarnessExtensions = defineRegistry<Extension, RegistrySnapshotSource>("studio.harness-extensions", {
  version: 1,
  compose: (table, { report }) => extensionSnapshot(table, report),      // one Durable Extension per plugin
});
const HarnessRuntime = defineRegistry<() => DurableHarness, () => DurableHarness>("studio.harness-runtime", {
  version: 1, compose: onlyEntry,                                        // core-private: one contributor
});

host.serve(Harness, (_input, self) => {
  const info = self.get(SessionInfo, {});
  const harness = self.open(async ({ signal }) => {
    const { id, dataDir } = info.init.value;
    const base = withContextValue(ChordHostKey, host, withAbortSignal(signal, BACKGROUND_CONTEXT));
    return DurableHarness.open(await openNodeSqliteStorage(join(dataDir, id, "durable.sqlite")), {
      models: () => host.registry(HarnessModels).value,                  // read at each use
      env: (target) => host.registry(HarnessEnvironments).value(target),
      settings: () => currentSettings(),
      registry: durableRegistry(host.registry(HarnessExtensions)),      // a RegistryReader over the composed value
    }, base);
  }, (h) => h.close(BACKGROUND_CONTEXT));
  self.contribute(HarnessRuntime, () => harness.value);                 // for core's conversation objects
  return { … };
}, { lifetime: "host" });
```

- **Lifetime `"host"`:** it runs for the worker's whole life, also while nobody holds it, because Durable tasks
  continue.
- **Base code:** it lives in the core facet, so a plugin reload never restarts it; only a base-code change (a host
  restart) does.
- **Registries, looked up at each use:** Durable's `models` and `settings` accept functions (pi `7ec1f648e`), so each
  generation gets the current value. After a models reload the next request uses the new runtime; a running stream
  finishes on the old one.
- **Durable's storage is its own.** Chord documents never commit together with Durable transcripts.

The design writes the call as `Durable.open(storage, { … })`; pi-durable's actual entry point is
`Harness.open(storage, options, context)`, used here as `DurableHarness` to keep it apart from the core object
`Harness`.

## Start order

At host start Chord loads every facet and waits until every facet and every `lifetime: "host"` object **other than the
harness** is live or failed: the **start barrier**. Then the registries hold the contributions of every plugin that
loaded, and the harness opens and resumes scheduling (R17). An object that must contribute at start, like the model
runtime, is therefore `lifetime: "host"`. Nothing waits for specific contributions; what is missing shows where it is
used:

| Missing | What happens |
| --- | --- |
| a tool | its call gets an error result the model sees |
| a model | the generation reports "model unavailable" and waits, not fails, until a model appears |
| a task definition | the task stays blocked (`missing_task`) until the plugin is installed or the task is aborted |
| a plugin that failed | reported with its error; a facet in backoff contributes later and the registries recompose |

The same holds when a session's database is copied to an instance with other plugins: missing tools, sections and
hooks are skipped, documents of missing plugins stay untouched, stored selections are never rewritten. The UI must
show blocked tasks with their reason and offer to abort them; a turn waiting on one hangs until then.

:::review | Review: the harness exception to the barrier (C17, R17)
R17 makes the harness start after the barrier, a special case in the barrier's rule. Review round 3 proposed cut C17:
no harness-specific exception; the harness is an ordinary object the app's start code holds after `load` resolves.
Not decided. `chord-next-walkthrough.md` concept 28 still says the harness's activation *is* the start barrier, which
R17 replaced.
:::

## Tools that call Chord

Durable tools, hooks and sections receive Durable's `ToolExecutionApi` (or `HookApi`) and a `Context`, never a Chord
`ctx` (Q6). Core put the host into the harness's base context under `ChordHostKey`, and every phase context inherits
it. A core helper opens a Chord call scope from any Durable context:

```ts
// studio/src/core/chord.ts
export function chord<T>(context: Context, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const host = context.value(ChordHostKey);
  if (!host) throw new Error("not inside the Studio harness");
  return host.root(fn, { signal: context.abortSignal, telemetry: context.telemetry });
}
```

The scope runs as the host principal; attribution is data; references taken with `ctx.get` are released when `fn`
settles. There is no wrapping of tools and no app-specific `defineTool`. The notes plugin gives the agent a tool:

```ts
// notes/worker.ts
const addNote = defineTool({
  name: "notes_add",                                         // tools are named <plugin>_<name>
  description: "Add a note to this session's notes panel",
  parameters: Type.Object({ text: Type.String({ maxLength: 2000 }) }),
  execute: (args, api, context) => chord(async (ctx) => {
    const info = await ctx.get(SessionInfo, {});
    const store = await ctx.get(NoteStore, { session: info.init.value.id });
    const id = await store.add({ text: args.text, by: `agent:${api.conversationId}` }, ctx);
    return { output: [{ type: "text", text: `added note ${id}` }] };
  }, context),
});

export default defineFacet((host, self) => {
  self.contribute(HarnessExtensions, defineExtension({ name: "@studio/notes", tools: [addNote] }));
  …
});
```

A reload of the notes plugin replaces its extension in the table; Durable pins a registry snapshot per task phase, so
a tool call already running finishes on the old code and the next phase uses the new one.

## Tools that need a person

Clients are not addressable, so a tool cannot call the user's tab. A tool that needs the user goes through an owner's
state: the Questions service (chapter XII). The model-facing `ask_user` tool and an approval hook both call
`Questions.ask`; tabs render the open questions and answer them.

```ts
hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (!needsApproval(call)) return undefined;
    const decided = await api.memo<boolean>("approval", context);       // a rerun does not ask again
    if (decided !== undefined) return decided ? undefined : { block: "Denied" };
    const allowed = await chord(async (ctx) => {
      const q = await ctx.get(Questions, { scope: { session } });
      for (;;) {
        try {
          const r = await q.ask(
            { kind: "confirm", message: `Run ${call.name}?`, allow: "Allow", deny: "Deny" },
            { audience: approvers, policy: { mode: "first" }, key: api.taskId },
            ctx,
          );
          return r.answer;
        } catch (error) {
          if (ctx.signal.aborted) throw error;                          // a link blip is not a denial: retry
          await backoff(ctx);
        }
      }
    }, context);
    await api.memo("approval", allowed, context);
    return allowed ? undefined : { block: "Denied by the user" };
  },
});
```

Durable runs `beforeTool` in the tool task's call phase; after the execute checkpoint a crash retries execution
without hooks, so the stored decision covers that retry. The approval must cover the final arguments: put the
approval hook after hooks that rewrite arguments.

## Conversations for the UI

Chat panels need a conversation's live view, submit, steer, stop. The design leaves p3's conversation API to the p3
design; one construction that follows the rules: a core `ConversationStore { conversation }` (local) opens the Durable
watch as its own native, getting the Durable harness from the core-private `HarnessRuntime` registry contribution (a
native may reach another object only through a registry entry), and exposes a bounded window as a derive. Per-principal
`Conversation { session, conversation }` views in front of it check who may send (chapter XIX).

## Code mode

Code mode is a plugin. It owns its `pi-codemode` sandbox as a native; its tool entry looks up the **current** sandbox
when `execute()` starts, so a call pinned by a phase before a reload (waiting in an approval hook, say) starts on the
new sandbox. On `reload` and `stop` the old sandbox is sealed and drained in `close`: running scripts finish or hit
their deadline, for at most 30 s (Q7). After a worker stop Durable replays as it does today.

## What lives where

| Data | Where |
| --- | --- |
| transcript-bound: entries, documents that fork and rewind with a conversation | Durable |
| app state: session list, notes, drafts, grants, settings | Chord documents |
| data core enforces on conversations (read-only one-shots, cwd followers) | a core per-conversation policy document, written when the conversation is created (`createConversation({ init })`) |

**Telemetry:** pass the host's adapter as `HarnessOptions.telemetry`; Durable stores trace carriers on submissions and
tasks (chapter XVII).
