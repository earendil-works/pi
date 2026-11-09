---
title: Pi Roam: what the base must enable
cover: Everything / As a Plugin
kicker: An explainer · Pi Roam base inventory · 2026-11-09
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
colophon: Pi Roam base inventory · explainer, first edition · 2026-11-09
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

# The Harness {#harness lede="One object in the session worker, two registries, three shapes, ordered by phase."}

Everything the agent gets comes from the harness, and every restriction on it too. The old coding agent had a flat bus
of about forty events; Durable already has the principled core. The harness keeps Durable's model and adds what makes
restrictions possible as plugins.

```ts
// plugins/harness/contract.worker.ts: the harness extensions object
/** Durable extensions as they are: tools, prompt sections, hooks (chains), wraps, tasks; with a phase for ordering. */
export const Extensions = defineRegistry<readonly HarnessExtension[], ExtensionTable>("harness.extensions", { version: 1 });
export type HarnessExtension = { readonly extension: Extension; readonly phase?: "security" | "transform" | "observe" };

/** Filters cut what extensions offer before anything runs, per session and conversation. */
export const Filters = defineRegistry<readonly HarnessFilter[], FilterTable>("harness.filters", { version: 1 });
export type HarnessFilter = {
	readonly tools?: (offered: readonly ToolRegistration[], scope: FilterScope) => readonly ToolRegistration[];
	readonly sections?: (offered: readonly PromptSection[], scope: FilterScope) => readonly PromptSection[];
	readonly environments?: (offered: readonly EnvironmentOffer[], scope: FilterScope) => readonly EnvironmentOffer[];
	readonly models?: (offered: readonly ModelOffer[], scope: FilterScope) => readonly ModelOffer[];
};
export type FilterScope = { readonly session: string; readonly conversation: ConversationId; readonly metadata: SessionMetadataReader };
```

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

# Sessions and Their Data {#sessions lede="A service plugins call, a metadata store on the server, and one format for backups and exports."}

Discord, automations, the orchestrator and triage all start sessions. They call one service:

```ts
// plugins/sessions/contract.server.ts: the session service (a required core plugin)
export const SessionService = local("sessions.service", {
	version: 1,
	params: {},
	members: {
		/** Idempotent by `key`: two racing first messages from a Discord channel create one session. */
		create: method(obj({ key: str(), origin: Origin, config: SessionConfig, location: nullable(Location), open: bool() }), SessionRef),
		configure: method(obj({ session: str(), change: SessionConfigChange })),
		archive: method(obj({ session: str() })),
		restore: method(obj({ session: str() })),
		fork: method(obj({ session: str(), at: opt(EntryRef) }), SessionRef),
		remove: method(obj({ session: str() })),
	},
});
/** Typed checks before each operation, so permission plugins gate them without the service knowing ACLs. */
export const SessionAdmissions = defineRegistry<readonly SessionAdmission[], AdmissionTable>("sessions.admissions", { version: 1 });
```

**Where session data lives** (decided today): two places, one rule.

```ts
// plugins/discord/contract.ts: a plugin's metadata about a session, defined once like defineState
export const ChannelBinding = defineSessionMetadata("discord.channel", obj({ guild: str(), channel: str(), open: bool() }));

// plugins/discord/server.ts: read and written by session id, no worker started
await metadata.write(ChannelBinding, session, { guild, channel, open: false }, ctx);
```

- **The session metadata store** on the server: anything about a session needed while its worker is off (title, pin,
  archive, location, a Discord binding, a plugin's labels). A rename is one server write.
- **The session's own store:** anything only used while the worker runs (the transcript, Durable's state).
- Never the same fact in both.

**Backups and exports** use the stores' sync format. A backup is the whole instance: server store, every session store,
files, the plugin manifest; restore runs before the server loads. An export is one session's store plus its metadata
entries; importing resolves its references to this instance's environments and providers; credentials never travel.
No live session sync: a session is useless without its instance.

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

Web and terminal keep separate registries; the terminal is not reduced to the web's shapes, nor the reverse.

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
