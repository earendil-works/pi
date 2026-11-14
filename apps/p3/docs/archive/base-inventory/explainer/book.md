---
title: Pi Roam: what the base must enable
cover: Everything / As a Plugin
kicker: An explainer · Pi Roam base inventory · second edition · 2026-11-09
subtitle: The smallest set of base pieces with which chat assistants, orchestrators, triage apps, automations, stats, Discord and backups are all plugins
stats:
  - 200+ | use cases from three independent inventories
  - 17 | base pieces after merging
  - 3 | tiers: base code, core plugins, ordinary plugins
  - 0 | permission engines in the base
note: |
  For the owner. The merged result of three inventories (Astra: products and UX; Sol: parity with all 39 p2 plugins
  and the old coding agent's extension API; Opus: what nobody listed yet), read against the decisions of the voice
  discussion on 2026-11-09. Sources: `apps/p3/docs/base-inventory/` (the three reports and `merged.md`),
  `apps/p3/docs/status-2026-11-09.md`, `apps/p3/docs/decisions.md`. Code is illustrative: names and shapes are
  proposals, Durable and Chord APIs are real. Nothing is built.
colophon: Pi Roam base inventory · explainer, second edition (types and worked features) · 2026-11-09
---

# Before we begin {.preface}

Mario wants a personal assistant he talks to through iMessage, with almost no screen. Armin wants a Home conversation
that sends work off to sessions in the background and shows an inbox of what needs him. The team wants the triage
agent's issue analysis inside Pi, one tap from "continue in a session". Someone wants cost statistics across every
session, someone else a Discord channel that gets its own locked-down session on its first message. And everyone wants
backups, so a dead laptop costs nothing.

None of these should be built into Pi. The question the owner set as the guiding light is the opposite one: **does the
base offer everything needed to build each of them as a plugin?** Three subagents went broad, from different angles,
and listed more than two hundred use cases with the base pieces each needs. This book is the merge: seventeen pieces,
sorted into what must be base code, what can be a reloadable core plugin, and what is an ordinary plugin.

## Eight things to know

:::findings
1. **The guiding light is "can it be a plugin?"** Every piece below exists because at least one product cannot be
   built without it, and most because dozens cannot.
2. **The instance is the trust boundary.** Permissions, ACLs and lock-downs are plugins built from hooks the base
   offers. There is no policy engine in the base.
3. **The harness is one object with two registries:** extensions (tools, prompt sections, hooks, wraps, tasks) and
   filters (what is offered). Hooks and wraps always apply; order comes from phases.
4. **Sessions are a service plugins call:** create, configure, archive, copy, delete, query, each with typed checks a
   plugin can hook before it runs.
5. **Session data lives in two places:** the session metadata store on the server (anything needed without the worker)
   and the session's own store. Backups and exports use one format.
6. **Waiting costs nothing.** A session waiting for a person, a webhook or a time holds no process: Durable suspends
   the work, the server remembers when to wake it.
7. **Questions are a base mechanism, the inbox is a plugin.** Ask, wait, answer from anywhere; renderers per form;
   late joiners see them because they are state.
8. **Some things can never be plugins:** principal kinds, tunnel ingress, restore, the plugin loader, real isolation.
   Everything else is, and most "base services" are reloadable core plugins, not frozen code.
:::

## Words used throughout

The **base** is what a plugin cannot replace: kit and base code that changes only with a restart. A **core plugin** is
a reloadable plugin every instance runs because other plugins depend on its contract (sessions, the harness). An
**ordinary plugin** is everything else. The **harness** is the session worker's object that builds what the agent gets.
A **filter** cuts what is offered; a **chain** (hook) sees each call or result and may change or block it; a **wrap**
goes around the whole thing. A **phase** orders them. **Suspended** work waits for an outside value without holding a
process. A **question** is a typed ask a person answers. The **metadata store** keeps what is known about a session
while its worker is off.

# What People Want to Build {#products lede="Fourteen themes from three inventories, and why each one is a plugin."}

The three inventories overlapped heavily once deduplicated. The themes, each a family of plugins:

| Theme | Examples |
| --- | --- |
| Assistants over chat apps | iMessage, WhatsApp, Slack, Discord, email; almost no UI |
| Orchestrator, Home, inbox | one conversation spawning background sessions; cards; "needs you" |
| Questions and approvals | typed asks, approvals around tools, review loops, sign-in codes, camera or file requests |
| Bespoke apps | the triage agent inside Pi, dashboards, boards, projects that become their own screens, agent-built views |
| Coding workflows | per-checkout sessions, diffs, worktrees, parallel helpers, PRs and CI cards, browsers |
| Automations | timers, cron reports, webhooks, watchers, scheduled sessions, hour-long jobs |
| Stats, analysis, search, memory | usage and cost, reading session content, search, knowledge across sessions, replay |
| Sharing and teams | a shared session, Radius guests, the team instance on a cloud machine |
| Discord and other ingress | a session per channel from a template, closed until opened, its own policy |
| Machines and tools | local, SSH, sandboxes, VMs, MCP, terminals, ports, computer use |
| Surfaces | voice, mobile, notifications, several devices, the terminal client |
| Data | whole-instance backups and restore, one-session export and import |
| Plugins | catalog, install, update, rollback, settings |
| The agent operating the instance | changing settings through typed contracts instead of files |

The rest of this book is the pieces they need, grouped by where they live.

# Sessions and Their Data {#sessions lede="Where everything about a session lives, and the service plugins call to create and change sessions."}

Discord, automations, the orchestrator and triage all create sessions, and many plugins keep facts about a session
that must be readable while its worker is off (a Discord channel binding, a title, an archive flag). This chapter
defines both: the session metadata store, then the session service.

Names are proposals; Chord (`local`, `remote`, `keyed`, `defineRegistry`, `defineState`, `self.writable`), Durable
(`Extension`, `ToolRegistration`, `PromptSection`, `ExecutionEnv`, `defineExtension`, `hook`, `ToolTask`,
`GenerationTask`) and pi-ai (`Model`, `Models`) are real. Every block names its file, so it is clear which facets can
import it: a plugin's `contract.ts` is bundled into all its facets, `contract.server.ts` only into server facets,
`contract.worker.ts` only into worker facets, `contract.web.ts` only into page facets.

## Session metadata

The rule (decided): anything about a session needed while its worker is off goes in the **session metadata store** on
the server; anything only used while the worker runs (the transcript, Durable's state) goes in the session's own
store; never both. A rename is one server write.

A plugin's metadata is a typed **key** it defines once, like `defineState`. The server stores one JSON value per key and
session, and checks the key's schema on every write (the trust boundary), so reads are typed without a second check.

A metadata key is a token a plugin defines once, like `defineState`. The server stores one JSON value per key and
session; the schema is checked on every write (the trust boundary), so reads are typed without a second check.

```ts
// plugins/sessions/contract.ts: shared by every facet
/** A typed key of the session metadata store, owned by the plugin that defines it. */
export type SessionMetadataKey<T extends JsonValue> = {
	readonly name: string;                 // written once, e.g. "discord.channel"
	readonly schema: Schema<T>;
	readonly "~value"?: T;                 // type only
};
export function defineSessionMetadata<S extends Schema>(name: string, schema: S): SessionMetadataKey<Static<S>>;

/** All metadata of one session as it crosses the wire: key name -> value (erased; read it with `metadataOf`). */
export const MetadataSnapshot = map(unknown());
export type MetadataSnapshot = Static<typeof MetadataSnapshot>;

/** The value of `key` in `snapshot`, typed by the key; undefined when absent. Validated when it was written. */
export function metadataOf<T extends JsonValue>(snapshot: MetadataSnapshot, key: SessionMetadataKey<T>): T | undefined;
```

```ts
// plugins/sessions/contract.server.ts: server facets only
/** The session metadata store (server, host lifetime). */
export const SessionMetadataStore = local("sessions.metadata", {
	version: 1,
	params: {},
	members: {
		/** Every session's metadata, by session id; pinned with `at(session)` or watched with `watch(session, ctx)`. */
		bySession: keyed(MetadataSnapshot),
		/** Writes one key's value for one session; validates `value` with the key's registered schema. */
		write: method(obj({ session: str(), key: str(), value: unknown() })),
		/** Removes one key's value for one session. */
		clear: method(obj({ session: str(), key: str() })),
	},
});
/** Registry: each plugin registers its metadata keys, so the store can validate writes and export them. */
export const SessionMetadataKeys = defineRegistry<readonly SessionMetadataKey<JsonValue>[], KeyIndex>("sessions.metadata-keys", { version: 1 });

/** Typed helpers over the store for server code. */
export function writeMetadata<T extends JsonValue>(store: Ref<typeof SessionMetadataStore>, key: SessionMetadataKey<T>, session: string, value: T, ctx: Ctx): Promise<void>;
export function readMetadata<T extends JsonValue>(store: Ref<typeof SessionMetadataStore>, key: SessionMetadataKey<T>, session: string, ctx: Ctx): Promise<T | undefined>;
```

```ts
// plugins/sessions/contract.ts: the worker's view of its own session's metadata
/** Served on the server; a session worker holds it with params {} (its principal names the session). */
export const SessionMetadataView = remote("sessions.metadata-view", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { metadata: MetadataSnapshot },
			methods: { write: method(obj({ key: str(), value: unknown() })) },   // one writer: the server's store
		},
	},
});
```

**Where the worker's snapshot comes from:** the sessions plugin's worker facet holds `SessionMetadataView` in a
host-lifetime object and contributes its `metadata` member to a worker registry, `SessionMetadata`, whose composed value
is the current `MetadataSnapshot`. Any worker code reads it with `self.registry(SessionMetadata)` and `metadataOf`.
That is the snapshot filters receive below; there is no separate reader type.

```ts
// plugins/sessions/contract.worker.ts
/** The current metadata of this worker's session, followed from the server. */
export const SessionMetadata = defineRegistry<Watchable<MetadataSnapshot>, MetadataSnapshot>("sessions.metadata-current", { version: 1 });
```

A short example, the Discord plugin's binding of a session to a channel, written on the server and read on the worker:

```ts
// plugins/discord/contract.ts: Discord's record, "this session belongs to that channel and may reach these sessions"
export const ChannelBinding = defineSessionMetadata("discord.channel", obj({ guild: str(), channel: str(), reach: arr(str()) }));

// plugins/discord/server.ts, inside the Discord plugin's server object: written by session id, no worker started
const metadata = self.get(SessionMetadataStore, {});
await writeMetadata(metadata, ChannelBinding, sessionId, { guild, channel, reach: [] }, ctx);

// plugins/discord/worker.ts, inside a worker object: read from the session's current metadata
const current = self.registry(SessionMetadata);                 // the snapshot, followed from the server
const binding = metadataOf(current.value, ChannelBinding);     // typed; undefined: not a Discord session
```

## The session service

```ts
// plugins/sessions/contract.ts
/** Who made a session: a typed origin a plugin defines (Discord channel, automation, Home), erased on the wire. */
export type SessionOrigin<T extends JsonValue> = { readonly name: string; readonly schema: Schema<T> };
export function defineSessionOrigin<S extends Schema>(name: string, schema: S): SessionOrigin<Static<S>>;
export const OriginData = obj({ name: str(), value: unknown() });

/** A model by provider and id, and a thinking level: the schemas of Durable's `ModelRef` and pi-ai's levels. */
export const ModelRef = obj({ provider: str(), modelId: str() });
export const ThinkingLevel = oneOf("off", "minimal", "low", "medium", "high", "xhigh");

/** What a session is configured with when created or reconfigured; every field optional on configure. */
export const SessionConfig = obj({
	title: str(),
	model: opt(ModelRef),                                  // from what the harness offers (chapter IV)
	thinkingLevel: opt(ThinkingLevel),
	tools: opt(arr(str())),                                // tool names chosen from the offers; absent: all offered
	location: nullable(obj({ environment: str(), cwd: str() })),   // null: no machine
	instructions: opt(str()),
});
/** A change on configure: absent fields stay. */
export const SessionConfigChange = obj({
	title: opt(str()), model: opt(ModelRef), thinkingLevel: opt(ThinkingLevel), tools: opt(arr(str())),
	location: opt(nullable(obj({ environment: str(), cwd: str() }))), instructions: opt(str()),
});
export const SessionRef = obj({ id: str() });
```

```ts
// plugins/sessions/contract.server.ts
export const SessionService = local("sessions.service", {
	version: 1,
	params: {},
	members: {
		/** Creates a session, or returns the one already created under `key` (idempotent). `open: false` holds input. */
		create: method(obj({ actor: str(), key: str(), origin: OriginData, config: SessionConfig, open: bool() }), SessionRef),
		configure: method(obj({ actor: str(), session: str(), change: SessionConfigChange })),
		open: method(obj({ actor: str(), session: str() })),          // starts accepting input
		archive: method(obj({ actor: str(), session: str() })),
		restore: method(obj({ actor: str(), session: str() })),
		fork: method(obj({ actor: str(), session: str(), at: opt(EntryId) }), SessionRef),
		remove: method(obj({ actor: str(), session: str() })),
	},
});

/** A check before an operation; every contribution must allow. `actor` is the user the calling plugin acts for. */
export type Decision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: MessageData };
export type SessionAdmission = {
	readonly create?: (request: { actor: UserId; origin: Static<typeof OriginData>; config: Static<typeof SessionConfig> }) => Decision;
	readonly configure?: (request: { actor: UserId; session: string; change: Static<typeof SessionConfigChange> }) => Decision;
	readonly archive?: (request: { actor: UserId; session: string }) => Decision;
	readonly fork?: (request: { actor: UserId; session: string }) => Decision;
	readonly remove?: (request: { actor: UserId; session: string }) => Decision;
};
export const SessionAdmissions = defineRegistry<SessionAdmission, readonly SessionAdmission[]>("sessions.admissions", { version: 1 });
```

`actor` is data because a local call runs as the server (Chord §4): a plugin passes the link-stamped principal of its own
user-facing method, or its own service identity for automated work. Pages call the sessions plugin's per-user remote view,
which stamps the actor itself.

## Backups and exports

Backups and exports use the stores' sync format. A **backup** is the whole instance: the server store (with the
metadata store), every session store, files and the plugin manifest; restore runs before the server loads. An
**export** is one session's store plus its metadata entries (the store knows every key through `SessionMetadataKeys`);
importing resolves its references to this instance's environments and providers; credentials never travel. There is no
live session sync: a session is useless without its instance.

# The Harness {#harness lede="One object in the session worker: extensions, filters, model and environment providers, composed per conversation."}

Everything the agent gets comes from the harness, and every restriction on it too. The old coding agent had a flat bus
of about forty events; Durable already has the principled core. The harness keeps Durable's model and adds what makes
restrictions possible as plugins.

## The contracts

The harness plugin defines these in its worker contract. Filters read the session metadata from the previous chapter.

```ts
// plugins/harness/contract.worker.ts
/** Where in the order an extension's hooks and wraps run. */
export type Phase = "security" | "transform" | "observe";

/** A Durable extension as plugins contribute it, with its phase (default "transform"). */
export type HarnessExtension = { readonly extension: Extension; readonly phase?: Phase };
export const HarnessExtensions = defineRegistry<
	readonly HarnessExtension[] | Watchable<readonly HarnessExtension[]>, readonly HarnessExtension[]
>("harness.extensions", { version: 1 });

/** What a filter is told: the session's metadata and the conversation it filters for. */
export type FilterScope = {
	readonly metadata: MetadataSnapshot;                        // from SessionMetadata (above)
	readonly conversation: {
		readonly id: ConversationId;
		readonly role: "main" | "subagent" | "one-shot";
		readonly parent?: ConversationId;
	};
};

/** Cuts what extensions and providers offer; synchronous and pure over its arguments; all filters apply in turn. */
export type HarnessFilter = {
	readonly tools?: (tools: readonly ToolRegistration[], scope: FilterScope) => readonly ToolRegistration[];
	readonly sections?: (sections: readonly PromptSection[], scope: FilterScope) => readonly PromptSection[];
	readonly models?: (models: readonly OfferedModel[], scope: FilterScope) => readonly OfferedModel[];
	readonly environments?: (environments: readonly OfferedEnvironment[], scope: FilterScope) => readonly OfferedEnvironment[];
};
export const HarnessFilters = defineRegistry<HarnessFilter, readonly HarnessFilter[]>("harness.filters", { version: 1 });

/** Model providers from plugins; the harness builds Durable's `models` from them. */
export type ModelProviderContribution = { readonly id: string; readonly label: MessageData; readonly models: Models };
export const ModelProviders = defineRegistry<
	ModelProviderContribution | Watchable<ModelProviderContribution>, readonly ModelProviderContribution[]
>("harness.model-providers", { version: 1 });
export type OfferedModel = { readonly provider: string; readonly id: string; readonly label: string; readonly model: Model<Api> };

/** Environment kinds from plugins; the harness builds Durable's `env` from them. */
export type EnvironmentProvider = {
	readonly kind: string;                                    // e.g. "envs.ssh", written once in the plugin's contract
	readonly offers: Watchable<readonly OfferedEnvironment[]>;
	resolve(id: string, cwd: string, context: Context): Promise<ExecutionEnv | undefined>;
};
export type OfferedEnvironment = { readonly id: string; readonly label: string; readonly kind: string; readonly capabilities: readonly ("shell" | "files" | "pty")[] };
export const EnvironmentProviders = defineRegistry<EnvironmentProvider, readonly EnvironmentProvider[]>("harness.environments", { version: 1 });
```

How the harness composes, once per change of any registry or of the metadata:

1. Install every `HarnessExtension` in Durable's registry, sorted by phase (security, transform, observe), and select all
   of them in every conversation; a conversation's own choice narrows only `AgentState.tools`.
2. For each conversation, run the filters over the installed tools and sections, the providers' models and the
   providers' environments, in contributor order; the result is what the conversation is **offered**.
3. Give Durable `models` that only resolve offered models and `env` that only resolves offered environments; a call to
   a tool that is not offered is refused at dispatch (nested and code mode calls included).

## Using them

Contributing tools is contributing a Durable extension, as in p2. A filter uses the key from the previous chapter:

```ts
// plugins/coding-tools/worker.ts
self.contribute(HarnessExtensions, [{ extension: defineExtension({ name: "coding", tools: [read, write, edit, bash] }) }]);

// plugins/discord/worker.ts: sessions bound to a channel are offered only two tools; other sessions are untouched
const ALLOWED = new Set(["conversations", "read"]);
self.contribute(HarnessFilters, {
	tools: (tools, scope) => metadataOf(scope.metadata, ChannelBinding) === undefined
		? tools
		: tools.filter((tool) => ALLOWED.has(tool.name)),
});
```

## A call through the three shapes

:::flow wide animate | A tool call through the three shapes: filters decided it was offered; wraps sit around the chain; the chain's hooks run in phase order.
row "Before anything runs" blue
box filter "Filters" "which tools, sections, environments, models a conversation is offered" blue
row "Around the call" accent
box wrap1 "security wraps" "outermost: see input first, output last" accent
box wrap2 "transform wraps" "nested inside"
row "The chain"
box before "beforeTool hooks" "change arguments or block; first block wins"
box exec "execute" "the tool itself"
box after "afterTool hooks" "replace the result"
arrow filter -> wrap1 "offered tool called"
arrow wrap1 -> wrap2
arrow wrap2 -> before
arrow before -> exec
arrow exec -> after
:::

The rules that make it work:

- **Hooks and wraps always apply,** in every conversation, whatever it selected. Durable alone runs only the hooks of
  extensions a conversation selects; the harness composes so that selection narrows tools and never switches off
  another plugin's hooks. Subagents choose tools from their caller's tools, after the filters.
- **Order comes from phases,** not from registration: security outermost, then transform, then observe; filters
  commute; a chain's first block wins; rewritten arguments are validated again.
- **Model providers and environments are contributions too.** Durable takes one `models` and one `env` function; the
  harness composes them from plugins: several providers and a router, several environment kinds with capabilities.
  An environment wrap sees requests, not effects: it is not confinement; a sandbox is.
- **One input path.** Web, terminal, chat connectors, other sessions and automations all submit through one typed
  path with source attribution; input hooks may transform, handle or refuse.
- **Observation is public.** Entries, documents, the commit signal, the task graph, usage and wake state are readable
  by plugins in the worker. Stats, search and memory observe there and push to their own server tables; no central
  event log.

The Discord policy, a tool settings sheet, an approval wrapper, a budget, redaction: each is one ordinary plugin that
contributes an extension and maybe a filter, and decides for itself which sessions it applies to.

# What Is Offered {#offered lede="How a page knows which tools, models and machines a conversation may use, so it can show selector sheets."}

The UI never guesses what exists. The harness serves each conversation's composed offer (after every filter of the
previous chapter) with the current choice, and one method to change it that refuses anything not offered.

The UI never guesses what exists: the harness serves the composed offer per conversation, so a page can show selector
sheets (tools, model, location) and change the choice through one method that validates against the same offer.

```ts
// plugins/harness/contract.ts: shared with the page
export const OfferedTool = obj({ name: str(), label: str(), description: str(), plugin: str(), chosen: bool() });
export const OfferedModelInfo = obj({ provider: str(), id: str(), label: str(), chosen: bool() });
export const OfferedEnvironmentInfo = obj({ id: str(), label: str(), kind: str(), chosen: bool() });

/** One conversation's offer and choice; held by pages through the server, served by the session's worker. */
export const ConversationOffer = remote("harness.offer", {
	version: 1,
	params: { session: str(), conversation: int() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: {
		user: {
			state: {
				tools: arr(OfferedTool),
				models: arr(OfferedModelInfo),
				environments: arr(OfferedEnvironmentInfo),
				cwd: nullable(str()),
			},
			methods: {
				/** Changes the conversation's choice; refused when a name is not offered (a filter removed it). */
				choose: method(obj({ tools: opt(arr(str())), model: opt(ModelRef), environment: opt(nullable(obj({ id: str(), cwd: str() }))) })),
			},
		},
	},
});
```

The state is a derive over the composed offer and the conversation's Durable agent state, so a filter change (Discord
locking the channel down) updates every open selector sheet at once.

A model picker sheet, using only that:

What it does: a sheet listing the models this conversation is offered (after every filter), the current one ticked;
choosing one changes the conversation.

```tsx
// plugins/chat/web.tsx (or any plugin's)
function ModelSheet({ session, conversation }: { session: string; conversation: number }) {
	const offer = useHold(ConversationOffer, { session, conversation });
	const models = useWatch(offer.models) ?? [];
	return <Sheet title={t("model")}>
		{models.map((m) => (
			<SheetRow key={`${m.provider}/${m.id}`} checked={m.chosen}
				onSelect={(ctx) => offer.choose({ model: { provider: m.provider, modelId: m.id } }, ctx)}>
				{m.label}
			</SheetRow>
		))}
	</Sheet>;
}
```

The tool and location sheets read `offer.tools` and `offer.environments` the same way. When the Discord filter removes
a tool, it disappears from the sheet in the same push; `choose` refuses a name that is no longer offered, so a stale
sheet cannot add it back.

# Waiting Costs Nothing {#waiting lede="Suspended work, a wake index on the server, and questions answered from anywhere."}

A session waiting for a person, a webhook or a time should not hold a process. p2 keeps a worker alive while any
Durable task is live, so an approval left for a night holds a process all night. Three pieces fix that:

1. **Suspendable work in Durable** (designed, `packages/durable/docs/suspendable/`): a task may suspend until a signal
   or a deadline; it holds no code; a signal delivered through the harness wakes it; escape cancels it at once. Hooks
   never suspend: `afterRun`, `afterTools` and `onYield` return child tasks the generation waits on.
2. **The wake bridge:** the worker publishes Durable's wake state; the server keeps a durable index of next wake
   times; a due wake starts the worker. Liveness comes from the wake state, not from counting tasks.
3. **Questions:** a plugin defines a question kind (payload and answer schemas); a tool or a hook asks; the worker
   pushes the open question to a server index; one server method answers.

:::sequence animate | A permission plugin asks before bash runs; the worker stops; the answer arrives from the phone; the tool continues.
actor worker "session worker" "harness" accent
actor server "server" "questions index, wake"
actor phone "Mario's phone" "inbox plugin" blue
worker -> worker: approval wrap: bash "rm -rf build" needs a yes
worker -> server: push open question (kind, summary)
worker => worker: tool task suspended; nothing runs
server --> worker: (worker idles out and stops)
server --> phone: index changed: "1 needs you"
phone -> server: answer { question, allow }
server => worker: start worker, signal the task
worker -> worker: resume: bash runs
worker -> server: question settled
:::

Questions are state, so a late joiner (the same user on the phone, an hour later) sees them through the same views.
They render through the UI registries, per form: a row in an inbox, a card in the transcript, a detail sheet, or a
Discord message from the Discord plugin. The inbox, notifications and approval policies are plugins.

## The question contracts

```ts
// plugins/questions/contract.ts
/** A kind of question, defined once by the plugin that asks it. */
export type QuestionKind<P extends JsonValue, A extends JsonValue> = {
	readonly name: string; readonly payload: Schema<P>; readonly answer: Schema<A>;
};
export function defineQuestion<P extends Schema, A extends Schema>(name: string, shape: { payload: P; answer: A }): QuestionKind<Static<P>, Static<A>>;

/** An open question as the server index holds it (erased; render it with the kind's renderers). */
export const OpenQuestion = obj({
	id: str(),                       // "<session>/<taskId>/<signal key>"
	session: str(), conversation: int(),
	kind: str(), payload: unknown(), summary: str(),
	asked: num(), until: nullable(num()),
});

/** Per user: the open questions of every session the user may see; `answer` validates with the kind's answer schema. */
export const Questions = remote("questions.open", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { user: { state: { open: arr(OpenQuestion) }, methods: { answer: method(obj({ id: str(), answer: unknown() })) } } },
});

// plugins/questions/contract.worker.ts
/**
 * Inside a tool's execute: suspends the tool until the question is answered (or `until` passes), using Durable's
 * suspendable work; on resume returns the typed answer, or "timeout".
 */
export function ask<P extends JsonValue, A extends JsonValue>(
	api: ToolExecutionApi, kind: QuestionKind<P, A>, payload: P, options?: { until?: number; summary?: string },
): Suspension | { readonly answered: A } | { readonly timeout: true };
```

The questions plugin's worker part watches the task graph for suspended tasks whose `request` names a question kind and
pushes them to the server index; `Questions.answer` routes to the session's worker (starting it), which calls
`Harness.signal(task, key, answer)`.


# The Page {#page lede="A route by kind and id, layouts, views per form, panels, groupings, commands: the page draws what plugins register."}

Every product above shows something different: a transcript, a Home with cards, a triage queue, a dashboard, nothing
at all for a chat assistant. The base only offers composition:

- a **route** addressed by `(kind, id)`, with `navigate` and deep links;
- **layouts**, one active; the default sidebar, transcript and panel layout is just a plugin;
- **views and renderers** per kind and form (row, card, detail), for sessions, machines, questions, tool calls,
  transcript entries; a missing renderer falls back;
- **panels** assembled from several plugins for one detail view;
- **groupings** that only show (recent, folders, projects, Discord servers);
- **commands, keybindings and composer extension points**;
- the PWA manifest and service worker delegated to plugins.

**How a page knows what it may offer.** Selector sheets (tools, model, location) never guess: the harness serves each
conversation's composed offer, after every filter, as `ConversationOffer { session, conversation }` with the current
choice ticked and one `choose` method that refuses anything not offered (chapter IV defines it and shows the model picker). When a filter changes, every open sheet updates in the same push.

Web and terminal keep separate registries; the terminal is not reduced to the web's shapes, nor the reverse.

## The page contracts

```ts
// plugins/presentation/contract.web.ts
/** A kind of thing pages can route to and render: a name written once and its typed params. */
export type ThingKind<P extends Record<string, string | number>> = { readonly name: string; readonly "~params"?: P };
export function defineThingKind<P extends Record<string, string | number>>(name: string): ThingKind<P>;
export type ThingRef = { readonly kind: string; readonly params: Readonly<Record<string, string | number>> };
export function thing<P extends Record<string, string | number>>(kind: ThingKind<P>, params: P): ThingRef;

/** A place things are drawn, with the props its views get. */
export type Form<Props> = { readonly name: string; readonly "~props"?: Props };
export const Row: Form<{ readonly density: "compact" | "comfortable" }>;
export const Card: Form<Record<never, never>>;
export const Detail: Form<Record<never, never>>;

export type View = { readonly kind: string; readonly form: string; readonly Component: ComponentType<{ readonly thing: ThingRef } & object> };
export function view<P extends Record<string, string | number>, Props>(kind: ThingKind<P>, form: Form<Props>, Component: ComponentType<{ params: P } & Props>): View;
export const Views = defineRegistry<readonly View[], ViewIndex>("presentation.views", { version: 1 });

/** Renders `thing` in `form` with the registered view, else the generic fallback. */
export function Present<Props>(props: { thing: ThingRef; form: Form<Props> } & Props): ReactElement;
/** Moves the page's route to `thing` (deep-linkable). */
export function useNavigate(): (thing: ThingRef) => void;

export type Layout = { readonly name: string; readonly label: MessageData; readonly Root: ComponentType };
export const Layouts = defineRegistry<readonly Layout[], LayoutIndex>("presentation.layouts", { version: 1 });
```

Question kinds are thing kinds too, so their renderers are ordinary views per form:

```ts
// plugins/questions/contract.web.ts
export const QuestionThing = defineThingKind<{ id: string }>("questions.question");   // id: OpenQuestion.id
```

# The Rest of the Base {#rest lede="Secrets, platform bindings, ingress, and the agent's typed surface."}

- **Secrets and settings:** one owner for secrets, encrypted, backed up as an opaque blob; plugin-owned settings
  with schemas, no global settings bag.
- **Platform bindings:** what only the start script holds today, exposed as narrow objects: a plugin manager
  (install, apply, roll back), reports from process start, keep-alive contributions, telemetry sinks, and the store
  bindings the harness needs.
- **Tunnel ingress and a public origin:** Radius or a tunnel plugin hands requests, sockets and Chord links to the
  HTTP component with their provenance; webhooks get a URL that survives moving the instance to another machine.
- **The agent's typed surface:** instead of a tool per setting, one generic surface over Chord contracts (list,
  describe, call), with model-readable descriptions and methods each plugin opts in.
- **Already there:** Chord's hosts, objects, principals, registries, documents, tables, routines and jobs; the kit's
  files, HTTP routes, sockets and authenticators.

# Building Features {#features lede="Three features end to end, using only what the previous chapters defined: a Discord channel session, an approval, usage stats."}

Each feature is an ordinary plugin: a `contract.ts` and the facets it needs. Nothing below touches the base.

## A session per Discord channel, locked down

What it does: the first message from a channel creates one session from a template, closed until the owner opens it;
the session only offers the conversation tool and file reading, and the conversation tool may only reach sessions
the owner marked for that channel.

```ts
// plugins/discord/contract.ts
export const ChannelBinding = defineSessionMetadata("discord.channel", obj({
	guild: str(), channel: str(),
	reach: arr(str()),                          // session ids the conversation tool may reach
}));
export const ChannelOrigin = defineSessionOrigin("discord.channel", obj({ guild: str(), channel: str() }));
const ALLOWED_TOOLS = ["conversations", "read"];   // tool names this policy keeps

// The plugin's own objects (host lifetime, empty params): one on the server, one in each session worker.
export const DiscordBridge = local("discord.bridge", { version: 1, params: {}, members: {} });   // the bot connection
export const DiscordPolicy = local("discord.policy", { version: 1, params: {}, members: {} });   // contributes the hook
```

```ts
// plugins/discord/server.ts
export default defineFacet((host, self) => {
	self.contribute(SessionMetadataKeys, [ChannelBinding]);
	host.serve(DiscordBridge, (_params, self) => {
		const sessions = self.get(SessionService, {});
		const metadata = self.get(SessionMetadataStore, {});
		const bot = self.open((ctx) => connectBot(ctx), (b) => b.close());   // discord.js client, a native of this object
		const BOT_ACTOR = INSTANCE;                         // the instance user (users plugin): automated work acts for it
		self.onLive(async (ctx) => {
			for await (const message of bot.value.messages(ctx)) {
				// Idempotent by key: racing first messages from one channel create one session.
				const { id } = await sessions.create({
					actor: BOT_ACTOR,
					key: `discord:${message.guild}:${message.channel}`,
					origin: { name: ChannelOrigin.name, value: { guild: message.guild, channel: message.channel } },
					config: { title: `#${message.channelName}`, tools: ALLOWED_TOOLS, location: null },
					open: false,                                    // held until the owner opens it
				}, ctx);
				if ((await readMetadata(metadata, ChannelBinding, id, ctx)) === undefined)
					await writeMetadata(metadata, ChannelBinding, id, { guild: message.guild, channel: message.channel, reach: [] }, ctx);
				await deliver(id, message, ctx);                    // the plugin's helper: submits through the one input path
			}
		});
		return {};
	});
});
```

```ts
// plugins/discord/worker.ts
export default defineFacet((host, self) => {
	// A filter: sessions bound to a channel are offered only the allowed tools; other sessions are untouched.
	self.contribute(HarnessFilters, {
		tools: (tools, scope) => metadataOf(scope.metadata, ChannelBinding) === undefined
			? tools
			: tools.filter((tool) => ALLOWED_TOOLS.includes(tool.name)),
	});
	// A security hook: the conversation tool may only reach the sessions marked for this channel.
	host.serve(DiscordPolicy, (_params, self) => {
		const metadata = self.registry(SessionMetadata);
		const extension = defineExtension({
			name: "discord.policy",
			hooks: [hook(ToolTask, {
				beforeTool: (call) => {
					const binding = metadataOf(metadata.value, ChannelBinding);
					if (binding === undefined || call.name !== "conversations") return undefined;
					const to = (call.arguments as { to?: string }).to;     // the conversations tool's typed args (its contract)
					return to === undefined || binding.reach.includes(to) ? undefined : { block: "not reachable from this channel" };
				},
			})],
		});
		self.contribute(HarnessExtensions, [{ extension, phase: "security" }]);
		return {};
	});
});
```

The owner opens the session from its detail view (`SessionService.open` through the sessions plugin's user view) and
ticks reachable sessions in a sheet the Discord plugin contributes as a `Detail` panel, which writes `ChannelBinding`
through the store. Every change reaches the filter and the hook through `SessionMetadata`: no restart, no reload.

## An approval before bash

What it does: before bash runs a command that matches a list, the session asks the owner; the worker may stop while
waiting; the answer arrives from any device; denial returns an error to the agent.

```ts
// plugins/approvals/contract.ts
const RISKY = [/\brm\s+-rf\b/, /\bgit\s+push\b/];   // commands that need a yes; the plugin's own setting in practice

export const ApproveCommand = defineQuestion("approvals.command", {
	payload: obj({ command: str() }),
	answer: union([obj({ kind: lit("allow") }), obj({ kind: lit("deny"), reason: opt(str()) })]),
});
```

```ts
// plugins/approvals/worker.ts
export default defineFacet((host, self) => {
	const extension = defineExtension({
		name: "approvals.bash",
		// A Durable wrap targets a tool by name; coding-tools exports BASH_TOOL in its contract.
		wraps: [{ tool: BASH_TOOL, wrap: (bash) => ({
			...bash,
			execute: async (args, api, context) => {
				if (!RISKY.some((pattern) => pattern.test(args.command))) return bash.execute(args, api, context);
				const asked = ask(api, ApproveCommand, { command: args.command }, { summary: `Run: ${args.command}` });
				if ("suspend" in asked) return asked;                       // the tool task suspends; no process needed
				if ("timeout" in asked || asked.answered.kind === "deny")
					return { output: [{ type: "text", text: "The owner did not approve this command." }], isError: true };
				return bash.execute(args, api, context);
			},
		}) }],
	});
	self.contribute(HarnessExtensions, [{ extension, phase: "security" }]);
});
```

```tsx
// plugins/approvals/web.tsx: how the question looks, per form; any page that lists questions uses these
self.contribute(Views, [
	view(QuestionThing, Card, ({ params }) => <ApprovalCard id={params.id} />),       // in the transcript
	view(QuestionThing, Row, ({ params }) => <ApprovalRow id={params.id} />),         // in an inbox plugin's list
]);
function ApprovalCard({ id }: { id: string }) {
	const questions = useHold(Questions, {});
	const open = useWatch(questions.open)?.find((q) => q.id === id);
	if (open === undefined) return null;
	return <Card title={open.summary}>
		<Button onClick={(ctx) => questions.answer({ id, answer: { kind: "allow" } }, ctx)}>Allow</Button>
		<Button onClick={(ctx) => questions.answer({ id, answer: { kind: "deny" } }, ctx)}>Deny</Button>
	</Card>;
}
```

## Usage statistics across sessions

What it does: tokens and cost per user and day, without starting idle workers to show the page.

```ts
// plugins/stats/contract.ts
export const DayUsage = obj({ day: str(), tokens: int(), costMicros: int(), turns: int() });
export const StatsFeed = remote("stats.feed", {
	version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { methods: { add: method(obj({ day: str(), tokens: int(), costMicros: int(), turns: int(), through: str() })) } } },
});
export const MyUsage = remote("stats.mine", {
	version: 1, params: {}, hostAddress: () => Server(),
	variants: { user: { state: { days: arr(DayUsage) } } },
});
```

```ts
// plugins/stats/worker.ts: an observe-phase hook; the response's usage, pushed as a delta
host.serve(UsageReporter, (_params, self) => {
	const feed = self.get(StatsFeed, {});
	const extension = defineExtension({
		name: "stats.usage",
		hooks: [hook(GenerationTask, {
			afterResponse: async (message, api, context) => {
				// chord(fn, context): runs a Chord call inside a Durable hook (design §24); today(): "YYYY-MM-DD"
				await chord((ctx) => feed.add({
					day: today(), tokens: message.usage.totalTokens, costMicros: Math.round(message.usage.cost.total * 1e6),
					turns: 1, through: `${api.taskId}`,                  // the server ignores a delta it has seen
				}, ctx), context);
			},
		})],
	});
	self.contribute(HarnessExtensions, [{ extension, phase: "observe" }]);
	return {};
});
```

```ts
// plugins/stats/server.ts: one row per user and day, one transaction per delta
const Days = defineTable("stats.days", { version: 1, columns: { user: str(), day: str(), tokens: int(), costMicros: int(), turns: int() }, key: ["user", "day"] });
// StatsStore: the plugin's host-lifetime server object owning `Days`; `add` updates one row in one transaction.
host.serve(StatsFeed, (_params, principal, self) => {
	const store = self.get(StatsStore, {});
	if (principal.kind !== "worker") throw forbidden("session workers only");
	return { variant: "worker", members: { add: (delta, ctx) => store.add({ session: principal.session, ...delta }, ctx) } };
});
```

The page holds `MyUsage` and draws a chart. A budget plugin would be the same hook in the security phase, refusing
the next request through `beforeRequest` once the day's cost passes a limit the owner set in its settings.

# Three Tiers {#tiers lede="What is base code, what is a reloadable core plugin, and what is an ordinary plugin."}

:::flow wide | The seventeen pieces by tier. Only the top row needs a restart to change.
row "Tier 1: base code (restart)" accent
box t1a "API and principals" "server, worker, user, guest" accent
box t1b "Root route and PWA hooks" "per surface" accent
box t1c "Platform bindings" "plugin manager, reports, keep-alive" accent
box t1d "Ingress, restore, Durable" "tunnels; restore before load; suspendable" accent
row "Tier 2: core plugins (reloadable, required)" blue
box t2a "Sessions" "service, catalog, metadata, admissions, wake index" blue
box t2b "Harness" "extensions + filters, models, environments, input, observation" blue
box t2c "Questions, secrets, settings" "mechanisms" blue
box t2d "UI registries, backup" "default layout included" blue
row "Tier 3: ordinary plugins" muted
box t3a "Policy and people" "inbox, approvals, permissions, resource model, sharing" muted
box t3b "Ingress" "Discord, Slack, WhatsApp, iMessage, webhooks" muted
box t3c "Products" "triage, dashboards, Home, automations, stats" muted
box t3d "Tools and machines" "MCP, environments, terminals, voice" muted
:::

**What can never be a plugin,** and why: principal kinds (facets are typed by the app's principal union); tunnel
ingress (the app holds the HTTP listener and `host.accept`); restore (the data being restored holds the plugins); the
plugin loader and its rollback (it must work when plugins do not); keep-alive, reports and telemetry sinks (host
options); new worker kinds (start options); always-on hooks (only the harness owner can guarantee them); real
isolation (an OS, a VM or a remote service, never a hook); exactly-once external effects (idempotency keys and receipts
instead).

**What was cut:** compulsory resources, ACLs, projects, Home, inbox or ticket types in the base; a policy provider; a
central event log; a second workflow engine; a stringly action bus; fixed UI slots per product; mandatory payload
logging; compatibility with old pi's file formats and mutable events; live session sync.

# Open Questions {.epilogue lede="Fifteen, five of them only the owner can decide."}

**For the owner:**

1. **The UI people see when you share a session:** relay the instance's own UI (recommended: sandboxed frame,
   credentials only on Radius pages, no agent-driven plugin reloads while shared) or Cristina's Radius-built bundle.
2. **Read-only sharing:** keep a viewer that cannot send (recommended), or every viewer a full collaborator.
3. **Plugin workers:** a generic worker kind for heavy plugin work (indexing, sync, transcription), or not yet.
4. **Tool risk hints:** allow one annotations field like MCP's read-only and destructive hints, or keep policies on
   tool names (the earlier rule: no new fields on tool declarations).
5. **Secrets in backups:** encrypted with a recovery key, or references only.

**With a recommendation:** chat-network users stay attributed authors, not principals, until a plugin needs more;
built-in Durable tasks are reached only through their hooks; no further Durable boundaries until a plugin needs one;
environments usable from server objects through the environments plugin; no free-form transcript injection on create
(fork or import instead); cross-session input goes through the one input path; a stable public URL is the instance's
Radius identity; voice and live views use plugin sockets until a second user justifies a byte channel; the install
screen says plainly that plugins run in every session, locked or not.

# The Seventeen Pieces {.appendix}

| # | Piece | Host | Status |
| --- | --- | --- | --- |
| 1 | Chord substrate | all | exists |
| 2 | Session service and catalog | server | needed |
| 3 | Session metadata store | server | decided |
| 4 | Harness: extensions + filters, phases | worker | needed |
| 5 | Model providers and environments as contributions | worker | needed |
| 6 | One input path | worker | needed |
| 7 | Observation facade, read-only reader | worker, server | needed |
| 8 | Wake bridge and liveness | worker, server | needed |
| 9 | Suspendable work | Durable | designed |
| 10 | Questions | worker, server | needed |
| 11 | UI composition | page, terminal | needed |
| 12 | Files, HTTP, sockets, authenticators | server | exists |
| 13 | Secrets and settings | server | needed |
| 14 | Platform bindings | kit | needed |
| 15 | Backup, restore, export | kit, supervisor | needed, format decided |
| 16 | Tunnel ingress, public origin | kit | needed |
| 17 | The agent's typed surface | worker | direction |

# Acceptance Tests {.appendix}

1. A chat connector alone receives two duplicate webhooks while the worker is stopped: one input, one reply.
2. Racing first Discord messages create one session, closed, its filters active before the first model request.
3. Home and triage, installed independently: triage opens a session from an analysis, Home follows it.
4. A second layout and a third-party panel replace the default shell with no server change.
5. An approval suspends a tool and the worker stops; a withdrawn permission refuses the late answer at dispatch.
6. A future task survives a worker exit and a server restart and resumes on time with no client.
7. Stats recover from their own cursor; opening the dashboard starts no idle worker.
8. A reader cannot submit or reach a secret; revocation ends live references.
9. A whole instance restored on a clean machine shows missing plugins and accounts as repair steps.
10. One session exported, imported elsewhere, its environment and providers resolved, continued.
