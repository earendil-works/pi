# What the Pi Roam base must enable: an inventory (opus)

Angle: first the areas nobody listed in detail yet (automations, stats, memory, search, approvals, multi-device,
voice, TUI, browsers and computer use, sandboxes, MCP, backups and moving, team instances, plugin distribution,
agent-built UI, notifications, files and drives, email and calendar, long-running jobs), then the rest.

Sources read: `apps/p3/docs/direction-pi-roam.md`, `apps/p3/docs/decisions.md`, `apps/p3/docs/handoff.md`,
`apps/p3/docs/map/book.md` (API and registries proposed for step 0), `packages/durable/src/harness/types.ts` (all),
`packages/durable/src/types.ts` (task runtime, observers), `packages/durable/docs/spec.md` (hook selection),
`packages/chord/docs/design.md` §1-§5, §14-§20, §23-§24, `packages/chord/src/node/app/README.md`,
`packages/chord/docs/p3-features/book.md`, `packages/coding-agent/src/core/extensions/types.ts` (events, UI context),
`apps/p2/plugins/*` (file headers), `apps/p2/docs/questions.md`, `apps/p2/docs/workflows.md`, `/tmp/armin.txt`,
`/tmp/cristina.md`, `apps/p3/docs/coding-flow/index.html`, `apps/p3/docs/resource-model/book.md` (outline, MCP and
Discord chapters' headings), the triagent README (`earendil-works/pi-triagent`), the dsh-context README.

## How to read this

Every use case has three parts: **Experience** (what the user sees), **Build** (hosts and what the plugin contributes
or calls), **Needs** (base piece IDs from the catalogue below, each EXISTS or NEEDED; extra pieces specific to one
use case are spelled out inline). Hosts: **server**, **worker** (a session's worker, one per session), **page**,
**terminal** (TUI), plus **hand** (a machine that connects to the instance) and **Radius** (outside the instance).

Two facts shape almost every answer below:

1. **Every plugin's worker facet loads in every session worker** (the kit ships "the kind's complete current scripts",
   design §23 Workers). So a plugin can observe or act inside any session without the session selecting it. This is
   what makes stats, search, memory capture and chat bridges plugins without a central event bus.
2. **Durable runs only the hooks and wraps of extensions a conversation selects; there is no registry-wide hook or
   wrapper** (`packages/durable/docs/spec.md:6523`, `harness/agent.ts:217`). A policy that must hold whatever a
   session selects (Discord lock-down, budgets, approvals, redaction) therefore needs p3 to add "always-on" chains,
   filters and wraps itself. This is the single most important base gap for the owner's "restrictions are plugins".

## Catalogue of base pieces

### EXISTS (Chord, the kit, Durable)

| ID | Piece | Where |
| --- | --- | --- |
| X-OBJ | objects, documents, tables, live queries, derives, routines (`self.on`, `self.onLive` + `sleep`), jobs (persisted, `rerun`/`abandon`) | `packages/chord/docs/design.md` §5-§15; `src/jobs/`, `src/store/live-query.ts` |
| X-REG | registries, one contribution per contributor, writable contributions, `compose` | design §17; `src/registries/registry.ts` |
| X-HTTP | `Http` registry: routes (`public`, `page`, `crossSite`), wraps by phase, `sockets`, `relays`, `hosts`, `framers`, `csp`; `bytes` responses with ranges | `src/node/http/router.ts:138`, design §23 HTTP |
| X-AUTH | `Authenticators` registry (first principal wins) | `src/node/http/authenticate.ts:21` |
| X-SIGNIN | kit `Sessions` (issue/verify/revoke tokens), owner link, owner token file, device pairing, invites, ephemeral login, `defineUsers` | `src/node/app/sessions.ts`, `pairing.ts`, `invite.ts`, `ephemeral.ts`, `users.ts` |
| X-FILES | `Files` per host: spaces, paths, versions, blobs, live folders (`FilesFolder`), chunked uploads, `copyFiles` | `src/node/app/files.ts`, `uploads.ts`, `files-copy.ts` |
| X-EXPORT | `exportData` / `importData` per host address (store archive plus files) | `src/node/app/app.ts:267-272` |
| X-SYNC | store outbox and the sync client (upload batches, pull, snapshots, restore from archive) | `src/store/outbox.ts`, `src/sync/client.ts` |
| X-PLUGINS | plugin roots (app + user), install from git/npm, `applyChanges`, `plugins.state` | `src/node/plugins/install.ts`, `src/node/app/app.ts` (app-level only: no object a plugin can call) |
| X-WORKERS | a worker starts when something holds an object at its address; idle stop; `workers.state` | `src/node/workers/workers.ts`, design §23 Workers (state is app-level only) |
| X-PRESENCE | `host.references(Type)` (who looks), `host.activity` | design §19, §3 |
| X-SURF | page host with `useHold`/`useWatch`/`useRegistry`/`usePageState`; terminal launcher + sandbox + scope (`hold`, `watch`, `optimistic`) | `src/react/`, `src/node/tui/`, `src/tui/`, design §23 Web and TUI |
| X-I18N | `Themes`, `Translations`, `LocaleChoice` | `src/surfaces/themes.ts`, `src/surfaces/translations.ts` |
| X-TEL | telemetry spans and their store | `src/telemetry.ts`, `src/telemetry-sqlite/` |
| X-REVOKE | per-principal variants, `host.revoke` | design §4, §5 |
| D-HOOKS | Durable chain hooks: `beforeRequest`, `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools`, `afterRun` (+ `RunEndTask`), `beforeTool`, `afterTool`, `beforeCompact`; `HookApi.memo` | `packages/durable/src/harness/types.ts` (GenerationHooks, ToolHooks, CompactionHooks); selected extensions only |
| D-WRAP | `wrapTool`, `wrapSection` | `harness/types.ts` `Wrap`; selected extensions only |
| D-TASKS | tasks: `sleepUntil`, waits on tasks, background, ownership, `abortTask`, restart limit | `src/types.ts:340-362`, `harness/types.ts` |
| D-WAKE | `Harness.wake(): { active, at? }`, `onWake` | `harness/types.ts` `Wake`, `HarnessOptions.onWake` |
| D-OBS | `observeConversation`, `observeTaskGraph`, `observeDoc`, `observeCommits`; `ConversationView`; `pi.usage` per conversation, `Harness.usage()` | `harness/types.ts`, `src/types.ts:1101-1130`, `harness/usage.ts` |
| D-CONV | `createConversation({ ownership })`, `fork(at)`, `submit` (`input` with `entry: { kind, data }`, `whenBusy`, `whenIdle: "reject"`; `write`; `continue`), `reset(handoff)`, `compact`, `abort`, `context({ at })`, `inspect()` | `harness/types.ts` |
| D-AGENT | per-conversation `AgentState`: `extensions`, `tools`, `modelTools`, `instructions`, `cwd`, `maxTurns`, `compaction` | `harness/types.ts` |
| D-TOOL | `ToolRegistration`: `callers`, `deferred`, `replay`, `structuredOutputSchema`, `executeTool` (nested), `control` (`terminate`, `handoff`, `addTools`), images in results | `harness/types.ts` |
| D-ENV | `ExecutionEnv = FileSystem & Shell` | `packages/durable/src/env/index.ts:377` |
| D-CODEMODE | code mode, `tool_search` | `packages/durable/src/codemode/`, `src/tool-search/` |
| D-RO | open a harness read-only (viewer of a store another process drives) | `HarnessOptions.readOnly` |

### NEEDED (p3 base or kit)

Typed sketches; names follow the brief's parts (tools, prompt sections, models, environments, input, tasks) and its
three limit shapes (filter, chain, wrap).

| ID | Piece | Shape |
| --- | --- | --- |
| N-TOOLS | worker registry of tools | `Registry<readonly ToolRegistration[] \| Writable<…>, ToolTable>` (map/book.md proposes one `Extensions` registry instead) |
| N-SECTIONS | worker registry of prompt sections | `Registry<readonly PromptSection[], …>` |
| N-TASKS | worker registry of Durable task definitions | `Registry<readonly AnyTask[], …>` |
| N-MODELS | model providers | `Registry<Provider, Models>` (proposed, `apps/p3/docs/map/book.md`) |
| N-ENVS | environments | `Registry<{ kind: string; build(location: JsonObject, target: EnvTarget, ctx): ExecutionEnv \| undefined }, (location, target) => ExecutionEnv \| undefined>`; a session's location is `{ kind, ...params }`, not SSH-typed |
| N-INPUT | input handlers, before admission | `Registry<{ name; accept(input: { content: UserInput; entry?: InputEntry; from: InputSource }, api) => Pass \| { kind: "rewrite"; content } \| { kind: "answer"; entry: EntryDraft } \| { kind: "block"; reason } }>`; `InputSource = { kind: "person"; principal } \| { kind: "plugin"; plugin; ref? }` |
| N-FILTER | always-on filters per part | `Registry<{ tools?(t: ToolInfo, f: SessionFacts): boolean; sections?(key, f): boolean; models?(ref, f): boolean; environments?(loc, f): boolean }>` applied before Durable sees the snapshot |
| N-CHAIN | always-on hooks | `Registry<readonly HookRegistration[]>` run for every conversation of the session, whatever its `AgentState.extensions` (Durable has none: p3 composes them into every agent, or Durable gains "mandatory extensions") |
| N-WRAP | always-on wraps | `Registry<{ tools?: Wrap[]; sections?: Wrap[]; env?(env: ExecutionEnv, f: SessionFacts): ExecutionEnv; models?(m: Models, f: SessionFacts): Models }>` |
| N-NATIVE | the open harness for observers, and `chord(fn, context)` | `HarnessNative: Registry<Native<Harness>, Harness \| undefined>` (proposed, map/book.md) |
| N-FACTS | session facts in the worker, followed | `SessionFacts = { id; owner: UserId; origin?: { plugin: string; key: string }; template?: string; labels: readonly string[]; open: boolean }` as a watchable start-data object |
| N-KEEP | worker keep-alive counts from plugins | `KeepAlive` registry (map/book.md decision 1) |
| N-SESSIONS | server session service | `SessionService`: `create({ key?, origin?, template?, agent?, location?, title?, owner, open? }) → { id, created }` (idempotent by `origin+key`), `configure(id, change)`, `submit(id, draft, { conversation? }) → submissionId`, `abort(id)`, `open(id)`, `archive`, `unarchive`, `delete`, `fork(id, at?)`, `clone(id)` |
| N-CATALOG | session catalog table, per-principal live views | rows `{ id, title, owner, origin?, labels, status: "idle" \| "busy" \| "failed", wakeAt?, open, archived, usage: { cost, tokens }, lastActivity }`, pushed by workers (proposed as `SessionStore`, map/book.md) |
| N-WAKE | wake scheduler | worker pushes `Harness.wake().at` into the catalog; the server holds the session's worker at that time (Durable sleeps survive idle stops) |
| N-QUESTIONS | questions to people from running work | `Questions.ask({ key, session?, audience, question, deadline? }) → id`, `wait(id)`, `answer`, `cancel`; per-principal views; `QuestionKinds` renderers (design §20; `apps/p2/docs/questions.md`, design only) |
| N-POLICY | one replaceable guard of typed operations | `Policy: Registry<PolicyProvider, PolicyProvider>`, `decide(op: Operation, principal) → allow \| deny`; core asks it at create, submit, share, bring, install (resource-model/book.md "Who May") |
| N-SECRETS | secrets store | `Secrets` (server, local): `put({ owner, name, value })`, `get` (same host only), `list` (metadata), `remove`; encrypted at rest, never in plain exports |
| N-ORIGIN | where the instance is reachable | `PublicOrigin: Registry<{ url: string; kind: "local" \| "relay" \| "tunnel" }, readonly …[]>` for webhooks and links |
| N-INGRESS | requests, sockets and Chord links from a plugin's own tunnel | kit: `HttpIngress.accept(link \| request, { principal, provenance })` (the `relays` contribution covers only loopback-forwarded HTTP) |
| N-PLUGMGR | plugins as an object | `PluginManager`: `state`, `install`, `uninstall`, `apply`, `history`, `rollback(plugin, to)` over X-PLUGINS |
| N-SETTINGS | plugin settings | `Settings: Registry<{ plugin; schema; scope: "instance" \| "user" \| "session"; initial }>` + one store; values watchable on every host |
| N-REPORTS | host and worker failures for plugins | a table of `AppError`/`HostError`/Durable `Report` entries, per host, readable by plugins |
| N-HANDS | machines that dial in | hand enrollment (pairing), multiplexed hand protocol, `Hands` object with status; plugin capabilities beyond `ExecutionEnv` (screens, input, browsers) (proposed, p3-features book "Hands") |
| N-VIEWS | page and terminal composition | route `(kind, id)`; `Views` by addressable kind; `Layouts`; `Groupings`; `Slots` (bar, home, panel, header, footer) (decisions.md 2026-11-07) |
| N-RENDER | renderers | `Renderers` per entry kind, tool, contract, form (`row`, `card`, `detail`), page and terminal |
| N-COMMANDS | commands | `Commands` (slash, palette, keys; terminal and page; keybindings configurable) |
| N-COMPOSER | composer extension points | attachments, mentions, buttons (mic), drafts, target picker |
| N-BACKUP | stores and plugin root for backup plugins; restore before load | kit: every host's outbox/snapshot reachable by a plugin; supervisor imports a backup before the server loads |
| N-TELSINK | telemetry sinks | `TelemetrySinks` registry (export spans and metrics) |
| N-PWA | installable page | web manifest (icons, `share_target`), service worker at root scope (push) |

`X-` and `D-` IDs exist; `N-` IDs are needed. "Plugin contract" means a registry or object type defined in one
plugin's `contract.ts` that other plugins use (decision "Registry tokens, contracts and helpers live in the contract
file of the plugin that serves them"): not base.

---

# A. Automations

### U1. Scheduled agent runs and cron reports

- **Experience:** "Every weekday at 8:00, summarize yesterday's merged PRs and open issues and post it to #team and
  my Home." A row in an Automations screen shows the next run, the last outcome and its session; a failed run
  notifies him.
- **Build:** server: an `Automations` store (table of schedules `{ id, cron, template, prompt, deliver }`, document
  `lastRun` per schedule), one `onLive` routine that sleeps to the next due time and, per due schedule, calls
  `SessionService.create({ origin: { plugin: "automations", key: "<id>:<dueAt>" }, template, open: false })` (the key
  makes a crash-and-rerun idempotent) then `submit`. Worker: the plugin's worker facet follows its own sessions'
  `afterRun` (or observes the view through N-NATIVE) and pushes the answer to the server store, which delivers it
  through a notifications or Discord plugin contract. Page: a view and a Home slot.
- **Needs:** X-OBJ (routine with `sleep`, documents), N-SESSIONS (create by key, submit), N-FACTS (worker knows the
  session is an automation's), N-NATIVE or N-CHAIN (`afterRun`), N-CATALOG (closed sessions listed under
  Automations), N-VIEWS, N-SETTINGS (time zone, quiet hours).

### U2. Webhook-triggered sessions (GitHub, Sentry, Stripe, Linear)

- **Experience:** A GitHub `issues.opened` event starts a research session; a Sentry alert starts an investigation in
  the right checkout. Each shows up as a closed card in Home with a one-line result; he opens it when he wants.
- **Build:** server: a route `POST /hooks/github` contributed to `Http` as `public` (verifies the HMAC itself with a
  secret from `Secrets`), maps the event to `SessionService.create({ origin: { plugin: "github", key: "issue:123" } })`
  (redelivery dedupes), submits the event as input with `entry: { kind: "github.event", data }`; the setup page shows
  the webhook URL from `PublicOrigin`. Worker: none beyond the template's tools.
- **Needs:** X-HTTP (public route), N-ORIGIN (the URL to register, through Radius when the machine has no public
  address), N-INGRESS (requests arriving over the Radius relay), N-SECRETS, N-SESSIONS (idempotent create, submit),
  N-POLICY (an anonymous route creating sessions is the plugin's own authority: the plugin acts as itself), D-CONV
  (`InputEntry` with event data).

### U3. Watchers on machines and the web (file drops, logs, CI, RSS, prices)

- **Experience:** "When a PDF lands in ~/Inbox on my Mac, file it and extract the invoice." "Tell me when the
  Hetzner auction has a box under 40 EUR." The watcher shows as a chip with its last trigger.
- **Build:** server: a `Watchers` store; for machine paths, it holds the machine's environment and uses the env's
  watch (p2's daemon protocol has `watch`) through an `onLive` routine; for URLs, an `onLive` loop polls and diffs.
  A trigger calls `SessionService.create`/`submit` (or `submit` into an existing session). Hand: nothing new if the
  hand protocol exposes watches.
- **Needs:** X-OBJ, N-HANDS (watch capability, reachable from a server object, not only from a worker's
  `ExecutionEnv`), N-ENVS (an environment usable from the server: today `HarnessOptions.env` is a worker concern),
  N-SESSIONS, N-KEEP (none: runs on the server).
- **Gap named:** `ExecutionEnv` has no watch member (`packages/durable/src/env/index.ts`); a watcher needs a
  plugin-extensible capability set on hands.

### U4. Timers inside a conversation ("remind me at 5", "check the deploy in 20 minutes")

- **Experience:** He says "check whether the deploy is green at 17:00 and tell me". The session goes quiet, its worker
  stops after 5 idle minutes, and at 17:00 it runs again and pings him.
- **Build:** worker: a `schedule_check` tool that creates a Durable task (`createTask`) whose phase does
  `sleepUntil(at)` and then submits a `continue` or an input into its conversation. Server: nothing plugin-specific;
  the base must start the worker at `wake.at`.
- **Needs:** D-TASKS (`sleepUntil`), D-WAKE, N-TASKS (task definitions registered by the plugin), N-TOOLS, N-WAKE
  (without it a stopped worker never wakes: Durable arms a timer only in a live process).

### U5. Session lifecycle triggers ("when any run finishes or fails, ...")

- **Experience:** "When a background session finishes, put a two-line summary into Home." "When any run fails with a
  model error, notify me."
- **Build:** worker: the plugin's worker facet runs in every session; an object follows the root conversation's view
  through `HarnessNative` (`observeConversation`), detects settled runs and failures (`pi.live.runFailure`), and
  pushes `{ session, outcome, answerEntry }` to its own server store (push, never pull). Server: the store calls
  `SessionService.submit(home, { type: "write", entry: { kind: "home.card", data } })`.
- **Needs:** N-NATIVE, D-OBS, N-SESSIONS (cross-session `write`), N-CATALOG (which session is Home: a label),
  N-POLICY (a worker principal submitting into another session).
- **Considered and cut:** a central `SessionEvents` log in the base. Fact 1 above makes it unnecessary: each consumer
  observes in the worker and keeps its own server table. Cost: two consumers observe twice; acceptable.

### U6. Retention and housekeeping

- **Experience:** Sessions idle for 30 days are archived; archived Discord sessions older than 90 days are deleted;
  sandboxes nobody uses are destroyed at night.
- **Build:** server: a routine over the catalog's live query (`lastActivity < now - 30d`), calls
  `SessionService.archive`/`delete`; the sandboxes plugin's own routine for its VMs.
- **Needs:** N-CATALOG (queryable by `lastActivity`, `origin`), N-SESSIONS (`archive`, `delete`), X-OBJ.

---

# B. Stats and observability

### U7. Usage and cost across sessions

- **Experience:** A Usage screen: spend per day for 30 days, per model, per session, per origin (Discord, automations,
  Home), per user on a team instance; cache hit rate; the top 10 expensive sessions, each one tap from its transcript.
- **Build:** worker: an object follows `pi.usage` of every conversation (`observeDoc(UsageDoc)` through
  `HarnessNative`) and each assistant entry's `usage` (`observeConversation`), and pushes deltas `{ session, day,
  model, origin, user, usage }` to the server. Server: a `UsageStore` table with live queries per range; per-user
  attribution reads the submitting principal from the input entry's data. Page: a view with charts; a footer slot
  showing the session's spend.
- **Needs:** N-NATIVE, D-OBS (`pi.usage`, entries' usage), N-FACTS (origin, owner), N-CATALOG (usage column for
  sorting, titles), X-OBJ (tables, live queries), N-VIEWS, N-RENDER (footer slot), and **attribution of inputs**:
  the person who sent an input must be on its entry (D-CONV `InputEntry.data` EXISTS; the base's chat must always
  write it, so stats need not guess).
- **Gap named:** sessions that never run again are never re-observed; a backfill needs to read stopped sessions'
  stores (start the worker by holding, or D-RO on the server).

### U8. Context insight (dsh-context in Pi Roam)

- **Experience:** A Context tab per session: what fills the context (system prompt sections, tool results, images,
  summaries), its trend per request, compactions, file reads and commands; a Fleet tab with the agent, its parent and
  subagents as live cards; `/context` as a command.
- **Build:** worker: `Conversation.context()` gives `entries`, `contributions` and `messages`; sections are known from
  `PromptInput.shown`; per-request token counts from `afterResponse` (needs the hook always on). Task graph
  (`observeTaskGraph`) gives the fleet. Page and terminal: a view kind `session.context`, a panel, a command.
- **Needs:** N-NATIVE, D-OBS, N-CHAIN (`afterResponse` regardless of selection), N-VIEWS (a tab in the session's
  view: views assembled from panels several plugins contribute), N-COMMANDS, N-RENDER.

### U9. Budgets and quotas

- **Experience:** "No session may spend more than 5 USD without asking; guests 0.50 USD a day; the Discord bot 20 USD
  a day in total." When a cap is reached the run pauses with a card asking to raise it.
- **Build:** worker: a chain `beforeRequest` that reads the session's `pi.usage` and the plugin's server-side daily
  totals (cached, pushed), and when over the cap asks `Questions` (or blocks with an error the model sees). Server:
  totals per user and per origin from U7's feed.
- **Needs:** N-CHAIN (must hold whatever the session selects), N-QUESTIONS, N-FACTS (origin, owner), D-OBS, a way for
  a hook to end the run cleanly (`beforeRequest` can only rewrite messages: **NEEDED** a block result, or the hook
  calls `Conversation.abort()` through N-NATIVE).

### U10. Instance health, logs and reload results

- **Experience:** A Health screen: workers running, idle, failed (with the redacted error), plugin load and reload
  failures, registry conflicts, the last 200 reports; a red dot in the bar when something failed.
- **Build:** server: an object reading N-REPORTS and the workers' state; page: a view and a bar slot.
- **Needs:** N-REPORTS (today `onError` is the app's callback only), X-WORKERS state for plugins (fold into N-CATALOG
  `status: "failed"` per session), N-PLUGMGR (`state`: failed plugins), N-VIEWS.

### U11. Telemetry export and traces

- **Experience:** Spans for every request, tool call and reload land in Honeycomb or a local Jaeger; he follows one
  slow answer from submission to provider latency.
- **Build:** server and workers: a sink plugin.
- **Needs:** X-TEL (spans exist), N-TELSINK (the telemetry adapter is a host option today, so a plugin cannot add a
  sink).

### U12. Audit log on a team instance

- **Experience:** The admin sees who created which session, who shared what with whom, who installed a plugin, which
  tools ran in Discord sessions and on whose behalf.
- **Build:** the policy provider sees every guarded operation and can log it; tool calls from workers through U5's
  observation pattern.
- **Needs:** N-POLICY (one place every typed operation passes), N-NATIVE, X-OBJ.

---

# C. Memory, knowledge and search

### U13. Long-term memory across sessions

- **Experience:** Pi remembers that he prefers Biome over Prettier, that Cristina's roastery reorders at 20 kg, and
  that the Hetzner box is called slayer, across all sessions. A Memory screen lists, edits and forgets entries.
- **Build:** server: `MemoryStore` table `{ id, owner, scope: "user" | "project" | "instance", text, source: {
  session, entry } }`. Worker: tools `remember`/`forget` (N-TOOLS), a prompt section rendering relevant memories
  (N-SECTIONS, async render calling the server object), an `afterRun` task that extracts candidate memories with a
  cheap model (N-TASKS + `RunEndTask`). Page: a view; a renderer for the `memory.saved` entry kind.
- **Needs:** N-TOOLS, N-SECTIONS, N-TASKS, N-CHAIN (`afterRun` capture for every session, unless memory is a selected
  extension), N-FACTS (owner and project to scope reads), N-MODELS (a cheap model for extraction), N-POLICY (Discord
  sessions must not read the owner's private memories: a filter on the section by origin, N-FILTER).
- **Gap named:** embeddings. pi-ai has no embedding API; semantic recall needs a provider contract (plugin contract
  is enough) or full-text ranking (`packages/durable/src/search.ts` `rankDocuments` EXISTS).

### U14. Knowledge base over documents (RAG)

- **Experience:** "Answer from the Chord design doc and our Notion export." A Knowledge screen lists sources (a Files
  space, a Drive folder, a repo path on a machine) and their index state.
- **Build:** server: an indexer object with its own derived database (design §11 "plugin database": rebuilt, never
  synced), jobs per source; worker: a `kb_search` tool and an optional section.
- **Needs:** X-FILES (sources in a space), N-HANDS or N-ENVS from the server (read files on a machine), X-OBJ (jobs),
  N-TOOLS, N-SECRETS (Drive), N-SETTINGS.

### U15. Search everywhere (Cmd+K)

- **Experience:** One box searches session titles, messages, files, artifacts, issues of the triage app, memories, and
  commands; results open the right view.
- **Build:** server: the search plugin keeps an FTS index fed by every worker (p2's `plugins/search` does this with a
  worker feed); it defines a `SearchProviders` registry in its contract so other plugins add result kinds. Page and
  terminal: a palette overlay.
- **Needs:** N-NATIVE (feed from the transcript), N-CATALOG, N-VIEWS (results navigate to `(kind, id)`), N-COMMANDS
  (the palette), X-OBJ; `SearchProviders` is a plugin contract, not base.

### U16. Shared skills and prompt library

- **Experience:** Skills and prompt templates live in the instance (not only in a checkout); the team instance has a
  shared set, each user adds their own, a session shows which skills it got.
- **Build:** server: a skills store (Files space `skills`); worker: a section listing available skills, a tool to read
  one; templates offered by the composer (`/name`).
- **Needs:** N-SECTIONS, N-TOOLS, X-FILES, N-COMPOSER (template completion), N-FACTS (owner: per-user skills).

---

# D. Approvals and human in the loop

### U17. Tool approvals

- **Experience:** `bash` commands matching `rm -rf|git push|npm publish`, any tool of the email plugin that sends, and
  every tool in a Discord session outside a safe list ask first. The question shows in the session, in Home's "needs
  you" tray, as a push notification and (for Discord) as buttons in the channel; whoever answers first decides.
- **Build:** worker: a chain `beforeTool` that matches the call, `memo`s a question key (so a hook rerun after a crash
  reattaches), calls `Questions.ask({ key, session, audience: owner, question: { kind: "confirm" } })` and `wait`s,
  then returns `{ block }` or nothing. Server: `Questions` holds it; notification and Discord plugins render it.
- **Needs:** N-CHAIN (holds whatever the session selects), D-HOOKS (`beforeTool`, `HookApi.memo`), N-QUESTIONS,
  N-FACTS (origin decides the rule), N-KEEP (the worker stays alive while a tool waits; a running tool task already
  counts), N-RENDER (`QuestionKinds` renderers on page, terminal, Discord).
- **Gap named:** tools carry no risk annotations (MCP has `readOnlyHint`/`destructiveHint`); policies match by tool
  name. Owner rule: "no new fields on tool declarations". Open question below.

### U18. The agent asks people (ask_user, questionnaires, quorum)

- **Experience:** "Which of these three designs?" appears as a select in the session and on his phone; in a shared
  session, "ask everyone present" collects all answers with a deadline.
- **Build:** worker: an `ask_user` tool calling `Questions.ask` with `audience: "present"` (from `host.references`
  of the session's chat view) and a policy `all`/`quorum`.
- **Needs:** N-QUESTIONS, X-PRESENCE, N-TOOLS, N-RENDER.

### U19. The "needs you" inbox (Armin's Home tray)

- **Experience:** One tray counts everything waiting for him across all sessions: questions, approvals, finished work
  with a decision ("Which fix?"), lend requests. Each item answers in place.
- **Build:** server: the inbox is a derive over `Questions` (open questions for this principal) plus plugin items;
  the page shows a bar slot and a Home view section. Plugins that want items in it (a finished card with buttons)
  ask a question too.
- **Needs:** N-QUESTIONS (per-principal view of open questions across sessions), N-VIEWS (bar slot), N-RENDER.
  The inbox itself is a plugin; making every "needs you" thing a question keeps the base to one service.

### U20. Outbound side effects with an undo window

- **Experience:** The agent drafts an email, a GitHub comment, a calendar invite. They sit as drafts; "Send" runs
  after 6 seconds unless undone (triagent's pattern); some go out only after approval.
- **Build:** the outbound plugin's tool writes a draft to its server store and returns; the page shows the draft with
  Send; the server job sends after the window. Approval through `Questions` where required.
- **Needs:** X-OBJ (jobs with a delay, persisted), N-QUESTIONS, N-TOOLS, N-RENDER, N-SECRETS (the account's token).

---

# E. Chat apps and the personal assistant

### U21. Personal assistant over iMessage, WhatsApp, Telegram, Signal (the owner's OpenClaw case)

- **Experience:** He texts Pi from WhatsApp or iMessage; one long-running Home conversation answers, remembers, runs
  automations, sends reminders back to the same chat. Almost no UI; the page is for settings and looking back.
- **Build:** server: one bridge plugin per network owning the connection as a native (Telegram long poll or webhook;
  WhatsApp Cloud API webhook; Signal via `signal-cli` on a hand; iMessage via a Mac hand running BlueBubbles or
  AppleScript); a table `chat → session`; inbound message → `SessionService.submit(home, { type: "input", content,
  entry: { kind: "whatsapp.message", data: { from, chat, messageId } } })`. Worker: the bridge's facet observes the
  conversation; for each settled run it reads the run's entries (`RunSummary.first..last`), finds the inputs from its
  network and posts the answer back to their chat (replies route to where the question came from). Attachments go
  through `Files`.
- **Needs:** N-SESSIONS (submit into an existing session from the server), D-CONV (`InputEntry` provenance), N-NATIVE
  + D-OBS (answers, streaming edits from `ConversationView` live parts), N-CHAIN (`afterRun` if hooks are used
  instead), X-HTTP + N-ORIGIN + N-INGRESS (webhooks), N-HANDS (iMessage and Signal live on a machine), N-SECRETS,
  X-FILES, N-POLICY (who may text the assistant: the bridge maps phone numbers to users).

### U22. Discord integration (the owner's example)

- **Experience:** He connects the instance to a server. The first message in a channel creates a session from a
  template; it starts closed (not in his list) until he opens it. Its tools are limited (fixed environment, a safe
  tool set, the conversation tool only for sessions he marks); answers stream back into the channel; approvals show as
  buttons.
- **Build:** server: the Discord plugin's store owns the bots (p2: `plugins/discord/fleet.ts`, `bot.ts`), a table
  `channel → session`; first message → `SessionService.create({ origin: { plugin: "discord", key: channelId },
  template, open: false, location: sandbox })`, then `submit` with `entry: { kind: "discord.message", data: { author }
  }`. Worker: observation for replies (as U21). A separate policy plugin contributes N-FILTER (tools by
  `facts.origin.plugin === "discord"`), N-CHAIN (`beforeTool` on the conversation tool checks the marked sessions),
  N-WRAP (`env` wrap that pins the location). Page: a Discord grouping (servers → channels) and its own transcript
  view with Discord avatars.
- **Needs:** N-SESSIONS (`create` with `origin`, `open: false`), N-CATALOG (`open` flag; groupings read `origin`),
  N-FACTS, N-FILTER, N-CHAIN, N-WRAP, N-ENVS (a sandbox location), N-NATIVE, N-VIEWS (grouping kind, view kind),
  N-RENDER (`discord.message` entries), N-SECRETS (bot tokens: p2 keeps `discord.json` 0600), N-QUESTIONS (buttons).

### U23. Slack team bot

- **Experience:** In the team's Slack, threads become sessions; `/pi summarize` runs a template; approvals are Block
  Kit buttons that only the session's owner may press.
- **Build:** as U22; Slack Events API needs a public route (or Socket Mode: an outbound WebSocket native in a server
  object, no public route needed); slash commands are routes; buttons answer `Questions` as the mapped user.
- **Needs:** as U22, plus X-HTTP routes and N-ORIGIN (or Socket Mode), a mapping from Slack users to instance users
  (plugin table) and N-QUESTIONS answering on behalf of a mapped user (the plugin's server object answers as itself
  with the user as data: design §4 "upward is a boundary").

### U24. Email as a channel

- **Experience:** He forwards a mail to pi@his-domain or labels it "Pi" in Gmail; a session works on it and replies
  by mail (after approval).
- **Build:** server: Gmail push (Pub/Sub webhook) or IMAP IDLE in an `onLive` routine; mail → session by thread id as
  key; replies through the draft/undo pattern (U20). Mail content is untrusted: N-INPUT marks it as such.
- **Needs:** N-SESSIONS, N-SECRETS, X-HTTP + N-ORIGIN, N-INPUT (provenance and quarantine), N-QUESTIONS.

### U25. A phone number for the assistant (voice calls)

- **Experience:** He calls a number from the car; Pi answers with voice, uses Home's memory, can start work.
- **Build:** server: a Twilio plugin: a public webhook answering TwiML and a WebSocket media stream (`sockets`
  contribution) bridged to the speech service; transcribed turns are submitted into Home; Pi's text answers are
  synthesized back; barge-in aborts (`SessionService.abort`).
- **Needs:** X-HTTP (`sockets`, public routes), N-ORIGIN, N-INGRESS (a socket through Radius), N-SESSIONS (submit,
  abort, `whenBusy: "steer"`), N-NATIVE (streamed answer text), N-SECRETS.

---

# F. Home, orchestration, projects

### U26. Home orchestrator with cards (Armin's walkthrough)

- **Experience:** One Home conversation. Pi decides where work goes, starts sessions in the background, shows each as
  a live card (progress line, run 31 of 50), and brings results back with buttons. Tapping a card makes it the target
  of the next message; opening it goes one level down to the full transcript.
- **Build:** worker (Home's): tools `start_work({ prompt, project, location })` → `SessionService.create` + `submit`
  through `chord()`; `message_work({ session, text })` → `submit`; each start writes a `home.card` entry (`{ session
  }`). Server: nothing new. Page: a renderer for `home.card` that holds the target session's catalog row and a
  summary object the target worker serves (latest progress line); the composer's target picker (N-COMPOSER) sends to
  the card's session; results come back as in U5.
- **Needs:** N-SESSIONS, N-CATALOG, N-NATIVE (`chord()` from a tool), N-RENDER (cards holding another session's
  objects), N-COMPOSER (target), N-QUESTIONS (decisions with buttons), N-POLICY (Home's worker acts across sessions),
  N-VIEWS (Home as the default layout; "Recent" slot).

### U27. Projects that become screens; groupings

- **Experience:** "Roastery" appears from a sentence; it opens as a stock screen; Ask Pi in the bar works in the
  project's context; later a board, a roast log tab.
- **Build:** server: a projects plugin with a table of projects and memberships (p2: `plugins/projects`), a grouping
  kind; the project's screen is either a canvas (U33) or a plugin the agent wrote (U34). Project sessions get the
  project's resource list (resource-model plugin).
- **Needs:** N-VIEWS (grouping kinds, a view per `project` kind, layouts with "less transcript"), N-SESSIONS (create
  in a project: `labels` or the projects plugin's own membership table), N-CATALOG, N-FACTS (labels for policies), and
  a project's list of resources as a policy plugin (N-FILTER, N-WRAP, N-POLICY).

### U28. Subagent fleets and workflows

- **Experience:** "Look at the other three flaky tests": three helpers, each in its own worktree, one on slayer;
  results come back as one answer; a Fleet view shows them live.
- **Build:** worker: p2's `subagents`/`agent`/`codemode` port: child conversations (`createConversation({ ownership:
  { kind: "task" } })`) in the same session, or separate sessions through `SessionService` when they need their own
  location; worktrees through an environment provider.
- **Needs:** D-CONV, D-TASKS, D-CODEMODE, N-TOOLS, N-ENVS (worktree location kind; a child conversation's own `cwd`
  exists in `AgentState`, a child's own environment does not: `EnvTarget` has `conversationId` and `cwd`, so the
  provider can key on the conversation), N-SESSIONS (helpers as sessions), D-OBS (`observeTaskGraph`), N-VIEWS.

---

# G. Bespoke apps

### U29. Triage inside Pi Roam (triagent rebuilt as a plugin)

- **Experience:** A Triage screen: the inbox of untriaged issues on the left grouped by suggestion, the research on
  the right with Accept / p0 / p1 / none (6-second undo), tabs for report, comments, draft reply, fix diff, agent log.
  "Continue in a session" pulls the research conversation into a normal session where he keeps working with an agent;
  "Open PR" applies the proposed fix directly.
- **Build:** server: `TriageStore` with tables `issues`, `research`, `decisions`; an `onLive` routine syncing GitHub
  every 20 minutes (or a webhook, U2); a job queue (`concurrency: 2`) whose run creates a research session:
  `SessionService.create({ origin: { plugin: "triage", key: "issue:123:run:4" }, template: "triage-research",
  location: { kind: "gondolin", image: "pi-research" }, open: false })` + `submit(prompt)`. Worker: the triage
  plugin's tools `submit_research`, `submit_fix`, `save_reply` (offered only in triage sessions: N-FILTER on
  `facts.origin.plugin`), which call the server store through `chord()`; a chain `beforeRequest` enforcing the run's
  cost cap (`RESEARCH_MAX_COST`) and a server routine aborting after `RESEARCH_MINUTES`. Page: a view kind `triage`,
  its own layout (no transcript by default), keyboard commands (`j/k`, `Enter`, `u`). "Continue in a session":
  `SessionService.clone(researchSession)` (the clone is a normal open session with the owner's resources) and
  navigate. "Open PR": a server job applying the patch in a throwaway environment with the app's GitHub token.
- **Needs:** X-OBJ (tables, live queries, jobs with concurrency), N-SESSIONS (create with template and location,
  clone, abort), N-FILTER, N-CHAIN, N-FACTS, N-TOOLS, N-ENVS (Gondolin VM per run, checkpoint base image), N-NATIVE
  (`chord()`), N-VIEWS (own layout and route `/triage/:n`), N-COMMANDS (keys), N-RENDER (the agent log reuses the
  transcript renderer for a closed session), N-SECRETS (GitHub App key, per-user GitHub tokens), X-SIGNIN + N-POLICY
  (team: Google sign-in, decisions in the user's name), N-QUESTIONS (none needed: undo window is UI).

### U30. PR review bot and contributor PR gate

- **Experience:** Every contributor PR gets a review session; the result shows in a PR screen with "post review",
  "close with reason", "continue in session".
- **Build:** as U29 with a webhook trigger (U2) and a `pr-review` template.
- **Needs:** same as U29 plus X-HTTP public route, N-ORIGIN.

### U31. Small data apps from a spreadsheet (Roastery)

- **Experience:** "Track green coffee; warn me a week before we run out." Pi builds a stock screen from the
  spreadsheet, keeps it in sync, adds a roast log tab when asked; selecting two lots and pressing Reorder starts work
  with the selection attached.
- **Build:** either a canvas spec (U33) over a table the agent created through a generic data plugin, or a real
  plugin the agent wrote (U34). The selection travels as an input attachment (`entry.data.selection`); the warning is
  an automation (U1) over the table.
- **Needs:** N-VIEWS, N-COMPOSER (context attachment from a view: "what you select is what you ask about"),
  N-SESSIONS, X-OBJ, plus U33 or U34's needs.

### U32. Boards over sessions (Kanban, project status)

- **Experience:** A board with columns To do / Running / Needs you / Done; cards are sessions; dragging a card to
  Running starts it with the card's text.
- **Build:** page: a view of kind `board` reading the catalog's live view and the board plugin's own table of card
  positions; actions call `SessionService`.
- **Needs:** N-CATALOG (status, needs-you counts), N-SESSIONS, N-VIEWS, N-QUESTIONS (Needs you column).

---

# H. Agent-built UI

### U33. The agent composes a view (canvas)

- **Experience:** "Show me a table of my sessions this week with cost, and a button to archive the cheap ones." Pi
  answers with a small live view inside the conversation; "Open" makes it a full screen; it stays live (rows update),
  and its buttons do real things with a confirmation.
- **Build:** server: a canvas plugin keeps view specs as documents (`{ components: [{ kind: "table", source: {
  name: "sessions.recent", params } }, { kind: "button", action: { name: "sessions.archive", args } }] }`). It defines
  three registries in its contract: `Components` (page: kind → React component; terminal: kind → text renderer),
  `DataSources` (server: name → `{ params: Schema; query(params, principal, ctx) → Watchable<Row[]> }`), `Actions`
  (server: name → `{ args: Schema; run(args, principal, ctx) }`, each run through `Policy`). Worker: a tool
  `render_view(spec)` that validates the spec and writes a `canvas.view` entry. Other plugins contribute data sources
  and actions (sessions, usage, triage issues).
- **Needs:** N-RENDER (`canvas.view` entries), N-VIEWS (canvas as a view kind), N-POLICY (actions on behalf of the
  person who presses the button, not the agent), N-TOOLS, X-REG (registries in a plugin's contract), X-OBJ. The base
  needs nothing canvas-specific: the canvas is a plugin and the registries are its contract.

### U34. The agent writes a real plugin ("projects become apps")

- **Experience:** "Make Roastery its own app." Pi writes a plugin (server store, page view), shows a preview, he
  accepts, it is live without a restart; "how did this get here?" opens the session that wrote it; a bad change rolls
  back with one tap.
- **Build:** worker: tools that write files into a plugin directory and call `apply`; the session's environment must
  reach the user's plugin root (the instance's own data directory) or a staging copy. Server: `PluginManager` builds,
  reports build and load errors back to the tool (structured), keeps history, rolls back. Page: an "Apply changes?"
  question with the diff.
- **Needs:** N-PLUGMGR (`apply` with a report the tool returns; `rollback`; per-plugin provenance: which session wrote
  it), N-ENVS (a location kind `instance-plugins` over the user's plugin root, or a Files space the plugin manager
  builds from), N-QUESTIONS (approve before apply: an agent-written plugin runs with full rights; the instance is the
  trust boundary), X-PLUGINS (reload in place).
- **Gap named:** the kit's user plugin root is a directory on the server's disk; a session working on another
  machine cannot reach it. A plugin source space in `Files` with the plugin manager building from it removes the
  path problem and gives versions for free (X-FILES versions).

### U35. Artifacts with live data

- **Experience:** Pi makes an HTML report or chart (as p2's artifacts); it previews inline, opens full screen, can be
  shared by link; optionally it reads live data (a dashboard that refreshes).
- **Build:** worker: `artifact` tool writing to `Files` space `artifacts`; server: a route serving versions as
  `bytes` with `inline` and the sandbox CSP; live data through a `postMessage` bridge the page offers the frame, which
  only forwards to canvas `DataSources` (U33).
- **Needs:** X-FILES, X-HTTP (`bytes` inline sandboxed, `framers`), N-TOOLS, N-RENDER, N-VIEWS; the bridge is a
  plugin.

---

# I. Coding workflows

### U36. A coding session with review (the coding walkthrough)

- **Experience:** Say what is broken; Pi picks the checkout and machine (a chip); the card is live; one level down
  are the transcript, a live terminal, Changes, Files, Git; comments sit on diff lines; Accept keeps the change.
- **Build:** worker: coding tools (Durable `tools/`), environment from the location; workspace plugin (git status,
  diff) as objects in the worker using the environment. Page: a session view assembled from panels (Transcript,
  Changes, Files, Terminal); a line comment is an input with `entry: { kind: "review.comment", data: { file, line } }`.
- **Needs:** N-ENVS, N-TOOLS, N-VIEWS (panels from several plugins), N-RENDER, N-COMPOSER, D-CONV (`InputEntry`),
  N-CATALOG (the chip's title and location).

### U37. Machines asked for once, lent for one task

- **Experience:** "Run the full suite on slayer." slayer is not on pi-mono's list; Pi asks once (for this work /
  always for pi-mono / don't); while lent, a chip with a light shows it and has Stop.
- **Build:** the resources/policy plugin: a tool requesting a location raises a question; the answer adds a list entry
  (with expiry "this task"); the session's env wrap reads the list at each call; the bar slot shows active lends with
  usage lights from the env wrap's call counts.
- **Needs:** N-QUESTIONS, N-WRAP (`env` wrap counting and refusing), N-POLICY, N-FACTS, N-VIEWS (bar slot),
  N-HANDS (the machine connected).

### U38. Live shared terminal, previews and port forwards

- **Experience:** The terminal Pi types into is live on the page; he can type too and Pi sees it. A dev server Pi
  starts is previewed at a URL (through Radius when remote).
- **Build:** worker or server: terminals plugin (p2: PTYs via the daemon, ghostty-vt in the page) over a `sockets`
  route; previews through `Http` proxy routes and Radius forwards.
- **Needs:** X-HTTP (`sockets`, proxy routes, `hosts`), N-HANDS (PTYs that survive disconnects), N-KEEP (an attached
  terminal keeps the worker alive), N-INGRESS (sockets via Radius), N-VIEWS.

### U39. CI babysitter

- **Experience:** "Watch this PR until CI is green; fix flakes; ping me when it's mergeable." The session sleeps
  between checks and wakes on a check-run webhook.
- **Build:** worker: a task sleeping between polls (U4) or a webhook (U2) submitting into the session by key.
- **Needs:** D-TASKS, N-WAKE, N-SESSIONS (submit by `origin` key into an existing session), X-HTTP, N-ORIGIN.

---

# J. Machines, sandboxes, browsers, computer use

### U40. Connect machines (hands)

- **Experience:** `p3 hand enroll <instance>` on a laptop shows a code; he approves it on the phone; the machine
  appears with its status; sessions can work there; it works behind NAT through Radius.
- **Build:** a hands plugin: enrollment through pairing (X-SIGNIN), a server object holding the hand connections, an
  `Environments` contribution resolving `{ kind: "hand", hand, cwd }` to an `ExecutionEnv` over the hand protocol.
- **Needs:** N-HANDS, N-ENVS, X-SIGNIN (pairing), N-INGRESS (hands dialing through Radius), N-VIEWS (a machine view:
  files, terminals, later VNC: decision 2026-11-07).
- **Cannot be fully a plugin:** a worker reaches hands only through the server (p3-features book "Hands": "workers
  reach hands through the server's links"; design §3: workers reach each other through the server); the hand connection is a server native, the env a worker value, so the plugin
  needs a server object the worker's env provider calls per operation. Fine as a plugin, but the protocol's
  performance (data plane through the server) is a base concern.

### U41. Throwaway sandboxes per session or run

- **Experience:** Discord and triage sessions run in a fresh VM or container; a sandbox panel lists running
  sandboxes, their age and cost, with Stop.
- **Build:** a sandbox plugin per provider (Gondolin micro-VM, Docker, Radius sandboxes, Fly/Hetzner/E2B): a server
  object provisioning and reaping (jobs, routines), an `Environments` contribution; lifetimes tied to the session
  (archive or idle → stop) by following the catalog.
- **Needs:** N-ENVS, N-CATALOG (follow session state to reap), X-OBJ (jobs), N-SECRETS (cloud keys), N-WRAP (pin
  the session's env), N-KEEP.

### U42. Browser automation

- **Experience:** "Log into the supplier portal and download last month's invoices." A headless Chromium runs in the
  session's sandbox; a live view panel shows the page; he can take over when a captcha appears.
- **Build:** worker: browser tools (navigate, click, type, screenshot as image results) driving Playwright in the
  environment over the shell (or a CDP port forward); page: a live view panel (screencast frames over a socket or a
  VNC view); the takeover is a question ("solve the captcha, then continue").
- **Needs:** N-TOOLS, N-ENVS, D-TOOL (image results), X-HTTP (`sockets` for the screencast), N-HANDS (port or
  capability to reach CDP inside the env), N-QUESTIONS, N-VIEWS (a panel).
- **Gap named:** objects carry state, not streams; 35 FPS frames need channels (`packages/chord/docs/p3-features/book.md`
  "The litmus test"; design §23 "Channels", waiting for a user). A screencast at a few FPS over a socket is fine today.

### U43. Computer use on a desktop

- **Experience:** Pi operates his Mac (screenshot, mouse, keyboard) for an app without an API; a panel shows the
  screen; a big Stop.
- **Build:** a hand capability `screen` (capture, input) on macOS; worker tools using it; a VNC/WebRTC view on the
  page.
- **Needs:** N-HANDS (plugin-defined capabilities beyond `ExecutionEnv`), N-TOOLS, N-QUESTIONS (consent per task),
  N-WRAP (refuse when not lent), N-VIEWS.

### U44. His own browser as a tool (extension or WebMCP)

- **Experience:** With the Pi extension installed, the agent can read the page he is looking at, fill a form in his
  logged-in session, or grab a selection.
- **Build:** the extension signs in as a device (pairing) and connects as a client; clients serve no objects (design
  §3: "No client providers for now"), so it answers requests: a server object queues `BrowserRequest`s for that
  device, the extension watches them and answers (the Questions pattern, typed for tools). Or the extension is a hand
  with a `browser` capability.
- **Needs:** X-SIGNIN (device pairing), N-QUESTIONS (generalized: requests to a device), or N-HANDS; N-TOOLS.

---

# K. MCP

### U45. MCP servers as tools

- **Experience:** He adds Linear, GitHub and a local stdio server; signs in with OAuth on the page; tools appear in
  sessions of the projects that have them; a checkout's `.pi/mcp.json` suggests a server once.
- **Build:** server: an MCP manager (p2: `plugins/mcp/server.ts`: configuration, instances, OAuth sign-ins, leases per
  session); routes for the OAuth callback. Worker: an extension whose tools follow the server's per-session view
  (`self.writable` contribution changed by a routine), tools as `callers: ["tools"]` + `deferred` behind code mode or
  `tool_search`.
- **Needs:** N-TOOLS (writable), X-HTTP (OAuth callback route), N-ORIGIN (callback URL when remote), N-SECRETS (tokens
  per user), N-FACTS (owner and project decide which servers), N-POLICY (resource lists), N-ENVS (stdio servers run
  in an environment), N-KEEP (leases), D-TOOL (`callers`, `deferred`), D-CODEMODE.

### U46. Pi Roam as an MCP server

- **Experience:** Claude Desktop or Cursor on his laptop can list his sessions, start one in a checkout, read results,
  and answer the needs-you tray.
- **Build:** server: a `POST /mcp` route (streamable HTTP) authenticated with a device token (pairing), exposing tools
  backed by `SessionService`, `SessionCatalog`, `Questions`.
- **Needs:** X-HTTP, X-AUTH (bearer device tokens exist: X-SIGNIN), N-SESSIONS, N-CATALOG, N-QUESTIONS, N-POLICY.

---

# L. Email, calendar, files and drives

### U47. Email triage assistant

- **Experience:** Every morning Pi sorts the inbox: drafts replies for approval, archives newsletters, lists what
  needs him. Sending needs his tap.
- **Build:** server: a mail plugin (Gmail API or `gog` on a machine) with an account per user in `Secrets`; an
  automation (U1) runs a template; tools read and draft; sending through the draft/undo pattern (U20). Untrusted
  content enters through N-INPUT as quoted data.
- **Needs:** N-SECRETS, N-SESSIONS, N-TOOLS, N-QUESTIONS, N-INPUT, N-CHAIN (approval on send whatever the session
  selects), N-SETTINGS (accounts, rules).

### U48. Calendar: briefings and scheduling

- **Experience:** 15 minutes before each meeting a briefing arrives (attendees, last emails, open issues); "find 30
  minutes with Armin next week" proposes slots and creates the invite after approval.
- **Build:** server: a calendar plugin syncing events (routine), scheduling a briefing per event (persisted timers in
  its store, one `onLive` loop to the next); each briefing an automation session; tools for free/busy and invites.
- **Needs:** X-OBJ (routine, documents for due times), N-SESSIONS, N-SECRETS, N-QUESTIONS, notifications (U53).

### U49. File drops and drives

- **Experience:** He shares a PDF from the phone's share sheet to Pi; it lands in Home with "file it?"; drag and drop
  into the composer attaches files; a Drive view shows the instance's files and synced Google Drive or Dropbox
  folders; sessions can read them as a mounted folder.
- **Build:** page: the PWA's `share_target` posts to a route that stores the file in `Files` (space `inbox`) and
  submits into Home; composer attachments upload in chunks (X-FILES uploads); a drive plugin syncs remote drives into
  a space (jobs, Secrets); an environment kind `files` exposes a space as a `FileSystem` to tools.
- **Needs:** N-PWA (`share_target`), X-HTTP, X-FILES, N-COMPOSER (attachments), N-SESSIONS (submit into Home),
  N-ENVS (a files-only environment), N-SECRETS.
- **Gap named:** `ExecutionEnv` is `FileSystem & Shell`; a drive has no shell. Either environments may lack `Shell`
  (tools check), or a drive is mounted into a real environment.

### U50. Meetings and audio

- **Experience:** He drops a meeting recording; Pi transcribes, summarizes, extracts tasks, drafts follow-up mails.
- **Build:** upload to `Files`; a server job calls a transcription service; the transcript is submitted into a
  session from a template.
- **Needs:** X-FILES, X-OBJ (jobs), N-SESSIONS, N-SECRETS; transcription as a plugin contract (no pi-ai API).

---

# M. Voice, mobile, multi-device, terminal, notifications

### U51. Voice mode

- **Experience:** Tap the mic; talk; Pi talks back; interrupt it mid-sentence (barge-in); in a shared session others
  hear Pi too (p2's voice rooms).
- **Build:** server: a socket route bridging browsers to the speech service (p2: `plugins/voice/server.ts`, token kept
  on the server); worker: a prompt section on while voice is on (p2: `plugins/voice/worker.ts`) and submissions with
  `whenBusy: "steer"`; page: a composer button and playback.
- **Needs:** X-HTTP (`sockets`), N-SECTIONS (with a per-session switch: a document), N-COMPOSER (mic button), N-NATIVE
  (live answer text to synthesize as it streams), N-SESSIONS (abort on barge-in), N-SECRETS (service token), N-KEEP
  (a room keeps the worker alive), X-PRESENCE.

### U52. Mobile PWA

- **Experience:** Installed on the home screen; push notifications for needs-you items; share sheet into Pi; works on
  flaky networks with optimistic sends and drafts kept.
- **Build:** page base: manifest and service worker; a push plugin keeps subscriptions (VAPID keys in `Secrets`);
  drafts plugin keeps composer drafts per user and conversation (p2: `plugins/drafts`).
- **Needs:** N-PWA, N-SECRETS, X-SURF (optimistic UI), N-QUESTIONS (what to push), N-COMPOSER (drafts).
- **Cannot be fully a plugin:** the service worker must be served at the root scope and registered by the page's
  base; the manifest is linked from the base's HTML. The base can delegate both to contributions (a route and a
  `<link>` slot), but it must leave the hook.

### U53. Notifications and routing

- **Experience:** He chooses where things reach him: needs-you items by push, finished automations by Discord DM,
  failures by email; quiet hours at night; one tap opens the right view.
- **Build:** server: a notifications plugin defining `NotificationChannels` (in its contract) with web push, ntfy,
  Discord DM, email; rules per user; plugins send `Notifications.send({ to, title, body, link: { kind, id } })`.
- **Needs:** N-ORIGIN (links), N-VIEWS (deep links to `(kind, id)`), N-SETTINGS (rules per user), N-SECRETS; the
  service is a plugin contract.

### U54. Multi-device continuity

- **Experience:** He starts on the phone, continues on the laptop where the draft, scroll position and unread markers
  are as he left them; "open on laptop" pushes the view there; a TUI on slayer shows the same sessions.
- **Build:** per-user state in server tables (unread, drafts); presence from `host.references` per device; "open on"
  is a notification with a deep link.
- **Needs:** X-PRESENCE, X-SIGNIN (devices), X-OBJ, N-VIEWS (deep links), N-CATALOG (per-principal views).

### U55. Terminal client with plugins

- **Experience:** `p3` in a terminal: sessions, transcript, commands, themes, keybindings, the plugin's own renderers
  and games (p3-features book: snake, Doom with two fixes).
- **Build:** each plugin's terminal facet contributes to the same registries as the page in terminal form.
- **Needs:** X-SURF (launcher, sandbox, scope), N-VIEWS, N-RENDER, N-COMMANDS (keybindings configurable, AGENTS.md
  rule), N-COMPOSER; plugin assets path for large assets (p3-features book: chunked reads through the plugin's
  server facet; X-FILES or a plugin route).

---

# N. Sharing, teams, Radius

### U56. Share a session (Cristina's proposal)

- **Experience:** One link per session through Radius; general access restricted / anyone view / anyone read-write;
  people by email get an email; anonymous guests (view only); Radius serves the UI bundle, the instance only data;
  revoking ends access at once.
- **Build:** server: the sharing plugin keeps links, people and guests; reports links to Radius through the Radius
  plugin; authenticates relay principals (`Authenticators`); per-principal variants decide what a guest sees; revoke
  through `host.revoke`. Page: share sheet.
- **Needs:** X-AUTH, X-REVOKE, N-INGRESS (Chord links from Radius with a relay-stamped principal), N-POLICY (guest
  may send?), N-CATALOG (guest-visible rows), N-VIEWS; the guest principal kind is reserved in p3 (decisions.md).
- **Cannot be a plugin:** the principal type is base (design §4: the app defines `P`; facets are typed by it). A
  plugin cannot add a principal kind; p3 must reserve `guest` (done) and probably a generic `{ kind: "external";
  provider; id; name }` for chat-network users and Radius users.

### U57. Team instance on a cloud machine (Earendil's 15-20 people)

- **Experience:** One click in Radius makes a persistent machine with Pi Roam; the admin installs plugins, adds the
  GitHub CLI login, mail and drive accounts, internal systems; people sign in with Radius or Google; each has a Home;
  a smaller circle has its own instance; the instance also sits in the team's Discord.
- **Build:** server: users (kit `defineUsers`), sign-in plugins (Radius, Google: `Authenticators` + routes), a policy
  plugin with admins and the instance user; per-user Home sessions created on first sign-in (`SessionService.create`
  with `owner`); shared resources owned by the instance user (resource-model book).
- **Needs:** X-SIGNIN (users, invites), X-AUTH, N-POLICY, N-SESSIONS (`owner` on create), N-CATALOG (per-principal
  views), N-SECRETS (instance-owned and user-owned), N-SETTINGS (instance scope vs user scope), N-PLUGMGR (admin
  installs), U7's per-user usage. First-run setup (accounts, plugins to install) is a plugin wizard.
- **Cannot be a plugin:** who the owner is at first start (kit `principal.owner`), and how the start script learns the
  admin on a Radius-provisioned machine (provisioning passes it as start data).

### U58. Backups to Radius, restore, move

- **Experience:** "Connect to Radius" and the instance's stores sync up continuously; on a new machine, "restore from
  Radius" brings back sessions, plugins, settings, secrets (if he unlocks them); moving an instance is backup on one
  machine, restore on another, then the old one stops.
- **Build:** server: the Radius plugin uploads every store's outbox batches (server store and each session worker's;
  X-SYNC), the user plugin root and `Files` blobs; encrypted secrets as an opaque blob. Restore: the supervisor (or
  `p3 restore`) pulls snapshots and imports them into an empty data directory before the server loads plugins.
- **Needs:** X-SYNC, X-EXPORT, N-BACKUP (plugin access to every host's outbox, including stopped workers' stores, and
  a restore step before load), N-SECRETS (exportable encrypted), N-PLUGMGR (the plugin set and its sources).
- **Cannot be a plugin:** restore. Plugins load from the data directory being restored; the server store is open
  while plugins run. Restore is a supervisor step (base), triggered by a plugin that stages the backup and asks for a
  restart into it.

### U59. Remote access through Radius

- **Experience:** He picks his instance in Radius and gets its UI as its plugins make it, from anywhere; if the
  machine is asleep, Radius says so.
- **Build:** server: the Radius plugin keeps one outbound WebSocket (p2: `plugins/radius/brain.ts`, 1142 lines) and
  hands each multiplexed channel to the HTTP component (pages, routes) or as a Chord link with the relay principal.
- **Needs:** N-INGRESS (the plugin needs `http.fetch`/`upgrade`/`host.accept` with a provenance; today only the app
  holds them), N-ORIGIN (the relay URL), X-AUTH.

### U60. Locked-down sessions (Discord, kids, guests, demos)

- **Experience:** A session that can only use a fixed environment and tool set, a fixed model, no memory of the
  owner, and the conversation tool limited to sessions he marks. The lock is visible ("Locked: 4 tools, sandbox") and
  only the owner can lift it.
- **Build:** a policy plugin: N-FILTER (tools, sections, models, environments by facts), N-CHAIN (`beforeTool`
  argument checks, e.g. which sessions the conversation tool may reach), N-WRAP (`env` pinned), N-POLICY (who may
  change the lock). Data: its own table keyed by session.
- **Needs:** N-FILTER, N-CHAIN, N-WRAP, N-FACTS, N-POLICY, N-RENDER (lock badge slot).
- **Gap named:** `AgentState` per conversation is writable by any code that calls `configure`; a lock must hold
  against a plugin that reconfigures the session. With p3 composing filters after Durable's selection (N-FILTER runs
  on the snapshot each request), `configure` cannot widen past them.

---

# O. Plugins: distribution, settings, models

### U61. Plugin catalog, install, update, rollback

- **Experience:** A Plugins screen: installed plugins with version, source, what each contributes (tools, routes,
  views), failures; a catalog (npm search for `pi-roam-plugin`, a curated list, the team's own); Install / Update /
  Disable / Roll back; "updates available" weekly.
- **Build:** server: a plugin manager plugin over `PluginManager`; a routine checking npm and git for updates; the
  contribution list from the registries' tables (each entry keeps its plugin name: design §17).
- **Needs:** N-PLUGMGR (install, uninstall, disable, update, rollback, history), X-PLUGINS, N-QUESTIONS (approve an
  update's diff), N-REPORTS (load failures), and a read of **what each plugin contributes** (registry tables by
  plugin: NEEDED as a kit introspection call).
- **Cannot be a plugin:** the plugin loader itself, version compatibility (`@p3/app/v1` resolution), and disabling a
  plugin that the manager itself depends on.

### U62. Plugin settings

- **Experience:** Each plugin has a settings card generated from its schema (instance-wide for admins, per user,
  per session); changes apply live.
- **Build:** plugins contribute `{ schema, scope, initial }`; one settings store; values watchable on server,
  workers and pages.
- **Needs:** N-SETTINGS.

### U63. Model gateway and routing

- **Experience:** Cheap model for titles and memory extraction, the strong one for work; failover when a provider is
  down; per-user API keys on a team instance; Radius's model gateway for people without keys.
- **Build:** provider plugins contribute to `ModelProviders`; a router plugin wraps `Models` (N-WRAP `models`) and
  picks per request; provider logins through `Questions`-style flows (design §20 flows) with tokens in `Secrets`.
- **Needs:** N-MODELS, N-WRAP, N-SECRETS, N-FACTS (owner: whose key), N-QUESTIONS (login flows), N-SETTINGS.

---

# P. Long-running work and the rest

### U64. Long-running jobs (hours)

- **Experience:** "Benchmark these three branches on the GPU box overnight." A card shows progress, survives server
  restarts and phone sleep, stops at a time or cost cap, and reports in the morning.
- **Build:** worker: Durable tasks with background ownership (D-TASKS), progress in documents, observed for the card;
  commands on a hand that survive disconnects; a `beforeRequest` chain for the cost cap; a server routine for the
  time cap (`SessionService.abort`).
- **Needs:** D-TASKS, N-KEEP (keep the worker while the task runs; Durable's `wake.active` must feed the worker's busy
  count), N-HANDS (detached commands reattach), N-CHAIN, N-SESSIONS (`abort`), N-RENDER (progress card), N-WAKE.

### U65. Import, export and move sessions

- **Experience:** Import a pi coding-agent `.jsonl`, a Claude Code session, or triagent's "Continue in pi" link as a
  session; export a session as Markdown/HTML or as an archive; move one session to another instance.
- **Build:** server: `SessionService.create({ init })` writing model entries (`EntryDraft` carries model messages);
  export through `exportData(Session({ id }))`; import with `importData` at a new address.
- **Needs:** N-SESSIONS (create with an initial transcript, or a hook to write entries before the first run), X-EXPORT,
  D-CONV (`write` entries with `model`).

### U66. Replay, fork from any entry, evaluations

- **Experience:** Scrub a session's history, fork at an entry to try another model; run one prompt across five
  models in throwaway sessions and compare results side by side.
- **Build:** worker: `Conversation.context({ at })`, `fork(at)`; server: an eval plugin creating N sessions with
  different `agent.model`, collecting answers (U5's pattern), a comparison view.
- **Needs:** D-CONV, N-SESSIONS (`fork`, `create` with `agent`), N-NATIVE, N-VIEWS.

### U67. Guardrails: redaction, PII, untrusted input

- **Experience:** Secrets that appear in tool output are masked before the model sees them; PII is redacted from
  requests to some providers; inputs from email and web pages are marked untrusted and their tool use limited.
- **Build:** N-CHAIN `afterTool` (rewrite results), `beforeProviderRequest` (payload), N-INPUT (mark provenance) and
  N-FILTER (fewer tools after untrusted input entered the context: a filter that reads `facts` plus the conversation's
  provenance flag).
- **Needs:** N-CHAIN, N-INPUT, N-FILTER, N-SECRETS (known values to redact).
- **Owner's rule applies:** preventing prompt injection is not the goal (decision 2026-11-08); limiting what is brought
  into a session is. These are optional plugins, not base policy.

### U68. Two instances working together

- **Experience:** Mario's instance asks Armin's instance to run something on Armin's machine, or shares a session
  across instances; each owner approves on their side.
- **Build:** each side runs an MCP server (U46) or a federation plugin over Radius; the remote side sees a principal
  of kind external/instance.
- **Needs:** U46's needs, N-INGRESS, N-POLICY, a principal kind for another instance (base, U56).

### U69. Home widgets and dashboards

- **Experience:** Home shows small widgets: today's calendar, spend this week, running work, the triage inbox count,
  the weather.
- **Build:** each plugin contributes a widget to a Home slot; the Home layout plugin orders them by the user's
  choice.
- **Needs:** N-VIEWS (`Slots` with per-user order), N-SETTINGS.

### U70. Session templates and personas

- **Experience:** Templates like "Discord helper", "Triage research", "Daily report", "Kids tutor": model, tools,
  instructions, environment, lock. Used by automations, bridges and the "new session" menu.
- **Build:** a templates plugin with a store and its own contract (`Templates.resolve(id) → { agent, location, lock,
  labels }`); `SessionService.create({ template })` asks a `SessionTemplates` registry or the caller resolves it.
- **Needs:** N-SESSIONS (`create` accepting an agent change and location), N-POLICY (who may use which template);
  templates themselves are a plugin contract, not base.

---

# Merged list of base pieces, ranked

Counted from the **Needs** lines of the 70 use cases above (U30 inherits U29's list and is counted only for what it
adds). The harness parts (N-TOOLS, N-SECTIONS, N-MODELS, N-ENVS, N-TASKS) are under-counted: every session that runs a
model needs them, so they are prerequisites rather than per-use-case needs.

| Rank | Piece | Count | Use cases |
| ---: | --- | ---: | --- |
| 1 | N-SESSIONS session service | 27 | U1 U2 U3 U5 U6 U21 U22 U24 U25 U26 U27 U28 U29 U31 U32 U39 U46 U47 U48 U49 U50 U51 U57 U64 U65 U66 U70 |
| 1 | N-VIEWS route `(kind, id)`, views, layouts, groupings, slots | 27 | U1 U7 U8 U10 U15 U19 U22 U26 U27 U28 U29 U31 U32 U33 U35 U36 U37 U38 U40 U42 U43 U53 U54 U55 U56 U66 U69 |
| 3 | N-QUESTIONS | 22 | U9 U17 U18 U19 U20 U22 U23 U24 U26 U29 U32 U34 U37 U42 U43 U44 U46 U47 U48 U52 U61 U63 |
| 4 | N-SECRETS | 21 | U2 U14 U20 U21 U22 U24 U25 U29 U41 U45 U47 U48 U49 U50 U51 U52 U53 U57 U58 U63 U67 |
| 5 | N-POLICY | 17 | U2 U5 U12 U13 U21 U26 U27 U29 U33 U37 U45 U46 U56 U57 U60 U68 U70 |
| 6 | N-CATALOG | 16 | U1 U5 U6 U7 U10 U15 U22 U26 U27 U32 U36 U41 U46 U54 U56 U57 |
| 6 | N-TOOLS | 16 (+ every session) | U4 U13 U14 U16 U18 U20 U28 U29 U33 U35 U36 U42 U43 U44 U45 U47 |
| 8 | N-RENDER | 15 | U7 U8 U17 U18 U19 U20 U22 U26 U29 U33 U35 U36 U55 U60 U64 |
| 8 | X-OBJ (EXISTS) | 15 | U1 U3 U6 U7 U12 U14 U15 U20 U29 U31 U33 U41 U48 U50 U54 |
| 10 | N-NATIVE (`HarnessNative`, `chord()`) | 14 | U1 U5 U7 U8 U9 U12 U15 U21 U22 U25 U26 U29 U51 U66 |
| 10 | X-HTTP (EXISTS) | 14 | U2 U21 U23 U24 U25 U30 U35 U38 U39 U42 U45 U46 U49 U51 |
| 12 | N-FACTS | 13 | U1 U7 U9 U13 U16 U17 U22 U27 U29 U37 U45 U60 U63 |
| 13 | N-CHAIN (always-on hooks) | 12 | U1 U8 U9 U13 U17 U21 U22 U29 U47 U60 U64 U67 |
| 13 | N-ENVS | 12 (+ every session) | U3 U14 U22 U28 U29 U34 U36 U40 U41 U42 U45 U49 |
| 15 | N-HANDS | 10 | U3 U14 U21 U37 U38 U40 U42 U43 U44 U64 |
| 15 | N-ORIGIN | 10 | U2 U21 U23 U24 U25 U30 U39 U45 U53 U59 |
| 17 | N-COMPOSER | 8 | U16 U26 U31 U36 U49 U51 U52 U55 |
| 17 | N-INGRESS | 8 | U2 U21 U25 U38 U40 U56 U59 U68 |
| 17 | N-SETTINGS | 8 | U1 U14 U47 U53 U57 U62 U63 U69 |
| 20 | N-KEEP | 7 | U3 U17 U38 U41 U45 U51 U64 |
| 20 | N-WRAP (always-on wraps, env and models wraps) | 7 | U22 U27 U37 U41 U43 U60 U63 |
| 20 | D-CONV, X-FILES (EXIST) | 7 each | see above |
| 23 | N-FILTER (always-on filters) | 6 | U13 U22 U27 U29 U60 U67 |
| 23 | D-OBS, X-SIGNIN (EXIST) | 6 each | see above |
| 25 | N-PLUGMGR | 5 | U10 U34 U57 U58 U61 |
| 26 | N-COMMANDS | 4 | U8 U15 U29 U55 |
| 26 | D-TASKS, X-AUTH (EXIST) | 4 each | see above |
| 28 | N-INPUT | 3 | U24 U47 U67 |
| 28 | N-SECTIONS | 3 (+ every session) | U13 U16 U51 |
| 28 | N-WAKE | 3 | U4 U39 U64 |
| 31 | N-MODELS | 2 (+ every session) | U13 U63 |
| 31 | N-TASKS | 2 | U4 U13 |
| 31 | N-PWA | 2 | U49 U52 |
| 31 | N-REPORTS | 2 | U10 U61 |
| 35 | N-BACKUP | 1 | U58 |
| 35 | N-TELSINK | 1 | U11 |

Pieces named once inside a use case and not in the catalogue: a block result for `beforeRequest` (U9), registry
introspection by plugin (U61), a files-only environment (U49), plugin capabilities on hands (U3, U43), external
principal kinds (U56, U68), session creation with an initial transcript (U65).

---

# The minimal set I propose

Three tiers, because "minimal base" and "stable API" are different questions. Base code (restart to change) stays
vocabulary, as decided ("Reloads first"); the providers are plugins of the required root.

## Tier 1: kit and base code (cannot be plugins)

1. **Principal kinds** `server`, `worker`, `user`, `guest`, plus one generic `{ kind: "external"; provider; id; name }`
   for chat-network users, Radius users and other instances (U21-U23, U56, U68). Plugins cannot add kinds (design §4).
2. **`HttpIngress`** (N-INGRESS): a plugin hands a tunnel's requests, sockets and Chord links to the HTTP component
   with a provenance and a principal. Without it, Radius remote access, sharing and webhooks over the relay cannot be a
   plugin (U59).
3. **Kit objects over app-held state:** `PluginManager` (N-PLUGMGR, with registry introspection by plugin),
   `Reports` (N-REPORTS), `KeepAlive` (N-KEEP), telemetry sinks (N-TELSINK), every host's outbox for backups
   (N-BACKUP).
4. **Supervisor restore:** import a staged backup into an empty data directory before the server loads (U58).
5. **Page base hooks:** route `(kind, id)` with `navigate`, `Layouts` (one active), `Views` by kind, and delegation of
   the manifest and root-scope service worker to contributions (N-PWA). Everything else on the page is a plugin.

## Tier 2: core contracts in `@p3/app/v1`, served by required-root plugins

6. **Harness parts** (worker): `Tools`, `PromptSections`, `Tasks`, `ModelProviders`, `Environments`, `Input`, as
   discussed; plus **one** `Limits` registry instead of three, whose contribution is
   `{ filter?: { tools?, sections?, models?, environments?, input? }; chain?: HookRegistration[]; wrap?: { tools?,
   sections?, env?, models? } }`, applied to every conversation of the session whatever its selection. This is the
   piece that makes restrictions, budgets, approvals and redaction plugins (N-FILTER, N-CHAIN, N-WRAP: 25 use cases
   together). `HarnessNative` + `chord()` for observers (14).
7. **Sessions** (one plugin, one owner): `SessionService` + `SessionCatalog` (rows double as the worker's
   `SessionFacts`; `wakeAt` makes it the wake scheduler; `status: "failed"` replaces exposing `workers.state`). Merges
   N-SESSIONS, N-CATALOG, N-FACTS, N-WAKE and the worker-state part of U10. `create` takes `{ key, origin, owner,
   agent, location, open, labels }`; templates are resolved by the caller.
8. **`Questions`** (22 use cases): asks, approvals, the inbox, login flows, device requests (U44). The inbox, push and
   chat buttons are plugins over it.
9. **`Policy`**: one provider, default "the owner may do everything", asked by the sessions, sharing and plugin
   manager providers at typed operations (create, submit across sessions, share, install, change a lock).
10. **`Secrets`** and **`Settings`**: one owner each; secrets encrypted and exportable as an opaque blob.
11. **`PublicOrigin`**: a registry token; Radius and tunnel plugins contribute.
12. **Page and terminal**: `Renderers` (entry kinds, tools, contracts by form) and `Commands`. Alternative layouts must
    honour them, so they are API, not a layout plugin's contract.

## Tier 3: plugin contracts (not base; first plugins define them)

Slots, groupings and the composer's extension points (contracts of the default layout and chat plugins); notification
channels; search providers; canvas `Components`/`DataSources`/`Actions`; templates; hands and their capabilities;
sandboxes; memory; usage store; MCP manager; triage, Discord, Slack, WhatsApp, voice. A replacement layout either
serves the same slot contracts or accepts that plugins targeting them do not show.

## Cut or merged

- **A central session event log** (cut): every plugin's worker facet runs in every session, so consumers observe there
  and push to their own server tables (U5, U7, U15, U21).
- **Three limit registries** merged into one `Limits` contribution per plugin.
- **N-CATALOG, N-FACTS, N-WAKE, worker state** merged into the sessions plugin.
- **Inbox, notifications, templates** as plugins over Questions and SessionService.
- **N-HANDS** is a plugin over `Environments`, once environments can be used from the server and carry capabilities
  beyond `ExecutionEnv` (open question 5).

## Cannot be a plugin, and why

| What | Why |
| --- | --- |
| Principal kinds | facets are typed by the app's principal union (design §4, §16) |
| Ingress from tunnels | `host.accept` and the HTTP component's `fetch`/`upgrade` are held by the app (design §3, §23) |
| Restore | plugins and the server store live in the data directory being restored |
| Plugin loading, API versions, rollback of a broken manager | the loader must work when plugins do not |
| Always-on limits | Durable runs hooks and wraps of selected extensions only (`spec.md:6523`); only the harness owner can guarantee them |
| Worker keep-alive, reports, telemetry sinks | host options and counts the kit owns (`host.activity`, `onError`, `telemetry`) |
| Root-scope service worker and manifest link | served from the page's base HTML |
| Who the owner is at first start | `principal.owner` is a kit start option |
| New worker host kinds | worker kinds are start-script options (kit `workers: [...]`); plugins cannot add one (open question 6) |

---

# Open questions

1. **Order of limits.** Contributor order is plugin-name order and "deliberately meaningless" (design §17). Filters
   commute (all must pass), a chain's first `block` wins, but argument rewrites and wraps do not commute. Rule
   proposal: limits must be order-independent except wraps, which the single `Policy` provider may order; or `Limits`
   is itself a one-provider registry like `Policy`.
2. **Where always-on limits live:** p3's harness composing them into every agent's selection, or Durable gaining
   mandatory extensions (a Durable change). The first keeps Durable unchanged; the second keeps selection honest in
   `Agent.extensions` and in Durable's own inspection.
3. **Long waits without a process.** An approval in `beforeTool` holds the tool task's invocation; the worker stays
   alive for hours. Acceptable (workers are processes, the owner's machine), or a Durable "parked until signalled"
   task state that lets the worker stop like a sleep does (a placeholder task that `sleepUntil(deadline)` and that the
   answer aborts already works with D-TASKS)?
4. **Tool risk annotations.** Approval and lock-down policies match tool names. MCP has `readOnlyHint` and
   `destructiveHint`. The owner's rule is "no new fields on tool declarations". Keep name lists, or allow one
   annotations field?
5. **Environments as capabilities.** `ExecutionEnv = FileSystem & Shell` has no watch, screen, browser, or PTY; a drive
   has no shell. Should `Environments` resolve to a capability set plugins extend, and be usable from server objects
   (watchers, indexers, PR jobs), not only from a worker's `HarnessOptions.env`?
6. **Plugin-owned worker kinds.** Heavy plugin work (indexing, sync, transcription, GitHub corpus) runs on the server
   process today. A generic `PluginWorker({ plugin, key })` kind would isolate it; without it a plugin's CPU-heavy
   routine slows every page.
7. **Generic external principal.** One `external` kind for Slack users, WhatsApp numbers, Radius accounts, other
   instances, or per-integration kinds in base?
8. **Initial transcripts.** `SessionService.create` with entries (imports, "Continue in a session" from triage), or
   always `clone`/`importData`?
9. **Cross-session authority.** Home's worker submits into other sessions; a Discord session's conversation tool
   reaches marked sessions. Is `submit { from: session }` a typed operation the `Policy` decides, with the worker
   principal as caller?
10. **Stats for sessions that do not run.** Start workers in batch for a backfill, or let a server object open a
    stopped session's store read-only (D-RO) under the worker's lock, as `exportData` does?
11. **Standard library tier.** Are Questions, Secrets, Settings, Renderers and Commands "base" (in `@p3/app/v1`,
    versioned with it) or contracts of shipped plugins that third-party plugins import by plugin name?
12. **Stable public URL across moves.** Webhooks and chat-network callbacks registered with an instance's URL break
    when it moves machines. Should `PublicOrigin`'s relay URL be the Radius identity of the instance, not the machine?
13. **Hands data plane.** Workers reach hands only through the server (design §3). Fine for commands; heavy file
    transfer and screencasts double the hops. Direct worker-to-hand links, or accept it?
14. **Streams.** Voice (U51, U25), browser live view (U42) and computer use (U43) want byte streams; design §23
    "Channels" waits for a second user. Are plugin `sockets` enough, or are these that user?
15. **Plugin trust inside locked sessions.** Every plugin's worker facet runs in every session, including a locked
    Discord session; the lock limits the model, not installed plugins. That is consistent with "the instance is the
    trust boundary", but the install screen should say so plainly.
