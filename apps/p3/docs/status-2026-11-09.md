# p3 / Pi Roam: state of the design discussion, 2026-11-09

Written by the p3 session (8b6ab5cc-8f95-421b-989a-de109636ff5a) at the owner's request, after a long voice discussion
on 2026-11-09, so that a later session or this one after a compaction can resume from here. Decisions are marked
**Decided** (also in `decisions.md`); everything else is the current direction or an open point. History is searchable
with the history tools (search terms: "Pi Roam", "filter chain wrap", "session metadata store", "suspendable",
"questions", "inventory").

## 1. Direction: Pi Roam (notes in `direction-pi-roam.md`)

From the owner's talk with Armin and Colin (2026-11-09):

- A personal Pi instance with its sessions and its own plugins; everything extensible: the page (transcript, sidebar,
  layouts), the session worker and the server. p3 provides the primitives.
- Radius offers backups of instances (restore onto a new machine), remote access to an instance (Radius relays the
  instance's own UI, built by its plugins), and a one-click cloud machine (Earendil's shared team instance, also in the
  Discord channels; whoever provisions it sets up what everybody may use; a smaller circle gets its own instance).
- **The instance is the trust boundary.** Whoever is on an instance can reach everything on it. Multiplayer inside one
  instance is not solved by this and in practice rarely used. Sharing a session stays: a viewer can reach whatever the
  session can reach; the sharer must be mindful.
- Environments stay: connect as many machines as you want.

## 2. Guiding principle

"Does the base offer everything to implement the thing as a plugin?" Find the minimal set of base pieces (services,
objects, registries, hooks, observable state, kit/Chord features) so that third-party plugins can build really
everything: permissions, automations, stats, chat integrations, orchestrators, inboxes, bespoke apps.

**Use case inventory (done, not merged):** three reports from the brief `base-inventory/base-inventory-brief.md`:
`base-inventory/base-inventory-astra.md` (products and UX: chat-app assistants, orchestrator + inbox, triage agent app,
dashboards, groupings, sharing, teams; 60 cases, 15 pieces), `base-inventory/base-inventory-sol.md` (parity with all 39 p2 plugins
and the old coding agent's extension API; 89 product rows, 14 seams, 11 gaps), `base-inventory/base-inventory-opus.md`
(automations, stats, memory, approvals, mobile, voice, browsers, backups, agent-built UI...; 70 cases). Findings worth
keeping: the most needed pieces are the session service, views addressed by (kind, id), questions, secrets; Durable
only runs hooks of selected extensions (fixed by the harness rule in §3); kit export/import is per worker, not
whole-instance; worker internals (store, busy, wake) are not reachable by plugins; most "base" pieces should be
reloadable standard plugins, not restart-bound base code; product conflicts: arbitrary custom UI vs a vetted viewer
bundle, folder-only lending vs shell, closing a tab vs stopping work. Copies of the brief and the three reports are in
`apps/p3/docs/base-inventory/`. **Next step:** merge the three into one list cut to the minimal base set, taking in the
decisions below.

## 3. The harness (the core of the design work; current direction)

The question is always: what does the session's worker get, and how is the agent limited in using it.

- **One harness extensions object in the worker, two registries:**
  1. the **extensions registry**: plugins contribute Durable extensions as they are, each with tools, prompt sections,
     hooks (chains on Durable's built-in tasks), wraps (around a tool or a section by name), and tasks (Durable task
     definitions);
  2. a **filter registry**: filters cut down what the extensions offer before anything runs, for tools, prompt
     sections, environments, and probably models. A filter is told which session and which conversation it filters
     for (subagents may get less; Discord threads differently).
- **Hooks and wraps always apply**, in every conversation, whatever a conversation selected (Durable today runs only
  the hooks of extensions a conversation selects: the p3 harness composes so that selection filters tools only, never
  switches off another extension's hooks). Order: extensions declare a phase (security outermost, then transform, then
  observe); within a phase wraps nest around the chain. No separate "limits" concept (the owner rejected the name and
  the extra registry).
- **The three shapes everywhere:** filter (what is possible before anything runs), chain (each contributor sees and
  may change or block, results passed along), wrap (around the whole thing, controlling input and output; wraps stack).
- **Subagents** (p2 `plugins/subagents/contract.worker.ts`, `resolveTools`): a subagent chooses tools from its caller's
  own tools, never more; filters run first, so a filtered tool cannot be chosen; a later filter change drops it from the
  recorded choice on reconfiguration; hooks and wraps are unaffected by a narrower choice.
- **Environments:** filter (which environments a session or conversation gets) and wrap (around the ExecutionEnv
  object every tool goes through: logging, all-or-nothing refusals) work; chain hooks are not needed. A wrap sees
  requests, not effects: restricting bash to a folder by wrapping exec is not a boundary; real confinement is a
  different environment (a sandbox).
- **Tasks registry** (Durable task definitions from plugins): tasks are stored by name and version; a plugin removed
  while its task runs leaves it parked (Durable: blocked on a missing definition); changing a task's shape needs a
  version bump and migration.
- **Harness observation is public to plugins:** read the session's entries and documents, a commit signal, the
  generation and tool hooks (usage and cost after each response, durations around tools).
- **Instructions and skills come from three scopes**, all as ordinary prompt-section contributors: the instance (global
  AGENTS.md and skills stored with the instance), the environment (the machine's home, e.g. `.pi` there), the project
  (AGENTS.md and skills found walking up from the working directory). All instruction files are included from broadest
  to most specific; for skills of the same name the most specific wins (project, then environment, then instance).
  Resolved per conversation (a subagent elsewhere gets that place's files); a relocation reloads the environment and
  project parts.
- The old coding agent's extension API (`packages/coding-agent/src/core/extensions/types.ts`: one flat bus of about 40
  events plus register functions, mutation in place, per-tool-name events) is a catalogue of what users wanted, not a
  model. Durable's extension model (tools, sections, hooks, wraps, tasks; AgentState selection) is the principled core.

## 4. Services and objects the base offers (current direction)

- **Session service on the server** (any plugin): create a session with a configuration (title, place, model, tools,
  which plugin made it), configure, archive. Discord, automations and orchestrators build on it.
- **Session metadata store** (**Decided**, `decisions.md`): see §6.
- **Questions ("ask a person")** as a base primitive (direction): a plugin defines a question kind once (payload schema,
  answer schema); a tool or hook asks and waits through the suspendable-work design (§5); the open question is stored
  in the session, the worker pushes it to a server index of open questions (observable by plugins and pages); one
  server method answers (routed to the worker, started on demand). Questions are state, not events: a late joiner (the
  same user on the phone) sees them through the same views; answering anywhere settles them. Rendering: question kinds
  use the same renderer registry as other things, per form (row in an inbox, card in the transcript, detail sheet);
  the defining plugin contributes renderers, others may add their own (Discord as a message), with a generic fallback.
  The **inbox** and **notifications** (push, iMessage, Discord) are plugins over the server index. **Permissions** stay
  plugins (wrap a tool, check, ask a person).
- **Automations are plugins.** The base must offer: the tasks registry; the harness's wake time as observable state
  (Durable's `onWake`/`wake()`, reported by the worker to the server so a stopped worker is started when due); starting a
  worker by holding its object (exists in Chord); inbound HTTP routes (kit Http registry, exists); the session service.
  Scheduler, webhook URLs and the agent's "remind me" tool belong to the automation plugin.
- **Stats** (like dsh-context) are a plugin: workers fold usage per turn and push small deltas to the plugin's own server
  tables (one row per user and day, one per session), updated in the same transaction; pages read indexed rows. Not
  projections over every session's log on every request (does not scale: 100 users x 1000 sessions). SQLite keeps
  indexes on disk as B-trees, read page by page; tables are not held in memory. Other plugins use the stats plugin's
  contract (views, methods), never its tables (in Chord a table belongs to one object).
- **Session analysis** (Armin's use: read session content): the session service lists sessions by recent activity and
  location; the base offers a read-only transcript reader on the server (Durable `readOnly` open, no worker start);
  analysis plugins run as jobs, a few sessions at a time; a JSONL export keeps outside scripts working.
- **The agent operating the instance through typed Chord contracts** (direction, open): instead of a tool per setting,
  one generic surface (ideally in code mode): list contracts, describe one (methods and argument schemas), call a
  method. Needs: contract and method descriptions readable by the model, plugins opting methods in, a decision on whom
  the agent acts as (on a personal instance the session's owner; risky calls could ask a person).
- **Principals:** fixed in base (a host has one principal type): server, worker, user, guest (with the grant it came
  in with; covers signed-in and anonymous sharing). Who becomes which is pluggable through authenticators (kit
  registry): Radius, share links, SAML.

## 5. Suspendable work in Durable (design by session c1e54598, reviewed)

Explainer (organization): https://radius.earendil.com/artifact/01m70d159cf0g91y306basdag6 ; files (uncommitted, docs
only): `packages/durable/docs/suspendable/spec.md` (S1-S10, S10 the review record), `book.md`, `index.html`.

- A new stored task status `suspended` (key, optional deadline, optional `request` for UIs); not active in `wake()`,
  only `at`. Escape (abort) ends it at once, as for sleeping tasks.
- Signals are task memos `pi.signal.<key>`, written by `Harness.signal(taskId, key, value)` / `tx.signal()`; first
  writer wins; accepted before the task suspends (an early webhook is not lost); closed after abort or deadline; woken
  keys leave a tombstone.
- Tools: `execute()` may return `{ suspend: { state, signal | until } }` and runs again with `api.resumed = { state,
  wake }` after an intent commit (no replay of unsafe code); `cancel(state)` on abort and before interrupted.
- Hooks never suspend: `afterRun` already returns child tasks the generation waits on (spec §8.3; motivation: hooks
  decide, tasks do durable work; ownership makes Stop, idle waits and abort cascades automatic). Extended: `afterTools`
  and `onYield` return tasks the generation waits on as children (new phases), yield tasks may complete with
  `{ continue }`. Approval is a tool wrapper keyed by an argument digest.
- p2/p3 consequence: worker liveness must come from Durable's wake state (today p2 counts every live task as busy:
  `apps/p2/plugins/status/worker.ts`, `Liveness` in `apps/p2/src/runtime/worker.ts`), and the worker hands the next
  `at` to the server durably before it exits.
- Additive API, but data-level version bumps (SQLite schema, pi.tool, pi.generation, pi.live) and a wider `execute`
  return type.
- **No hard-coded limits (owner):** the 32-value cap, the key length and the 4 KiB request limit were removed; the
  owner then also rejected `signalMaxBytes`, now gone (artifact version 4): a documented rule instead, never put large
  data in a signal or anything that lands in the task record; send a reference the task resolves (a document written
  first, or an ID to fetch). Open question
  first in S9: fold `suspended` into `sleeping`.

## 6. Session data and backups (**Decided**, `decisions.md`)

**Update (later on 2026-11-09):** the typed central metadata store below is superseded by host-keyed Chord documents and
table rows (`packages/chord/docs/decisions.md` "Documents and table rows can belong to a host"; p3 decision "Session
data on the server as host-keyed documents"): each plugin keeps per-session server data in its own object, keyed by
`Session({ id })`; export/import/delete find it through the store's new `host` column. The rule (worker off: server;
otherwise the session's store; never both) and backups-not-sync stand. A build of the Chord change was handed to a
subagent (`host-keyed`); its spec and code wait for review (code is never committed before the owner reviews it).


- **Session metadata store on the server** (base): everything about a session needed while its worker is not running
  (title, pin, archive, location, a Discord channel binding, a plugin's per-session labels or settings) goes there,
  under a typed key per plugin (defined once in the contract file, like `defineState`); server code reads and writes by
  session id without a worker; the worker reads its metadata through a view and writes through server methods.
  Everything only used while the worker runs (transcript, Durable state, a plugin's working data) goes in the session
  store. Never the same fact in both. A rename is one server write. Sessions stay self-contained as a unit: export =
  session store + its metadata entries; import writes both and resolves references to instance things (environment,
  providers; credentials never travel). No tagging of arbitrary tables, no pending edits.
- **Backups, not session sync:** no live per-session sync or remote read-only copies (a session is useless without its
  instance). Radius backs up whole instances (server store + all session stores) and restores onto a new machine. The
  **sync format** of Chord's stores stays the one format for backups and exports (it encodes everything in the core
  stores, plugin data included).

## 7. Permissions, recap

The instance is the trust boundary; sharing gives what the session reaches. Restrictions inside a session are plugins
using filters, chains and wraps (always applied, ordered by phase). The Discord case (direction): the Discord plugin
connects the instance to a server once (configured who may talk to Pi), creates one session per channel on its first
message from a template, the session starts closed (ingress held) until the owner opens it; its own harness extension
filters tools, checks conversation targets in beforeTool, filters list results; a per-session tool settings sheet (a
plugin reading the metadata store) tightens further. Approvals: a plugin wraps a tool and asks a person. A full
company ACL (the resource model spec, `resource-model/book.md`, third edition, with its explainer) is one optional
plugin, not base; the owner wants the spec kept (not trimmed or shelved) and discussed later.

## 8. Cristina's work and related

- Her sharing proposal (Radius artifact 01m6zs710df35vmptm8tz08fwq, `/tmp/cristina.md`): all shares through Radius,
  guests vouched by Radius, Option C (Radius builds the viewer UI bundle, cortex serves it per brain) to keep a brain's
  code out of guests' browsers. Our view: Radius already relays the brain's UI; per-brain origins already protect the
  guest's Radius account; remaining risks (phishing in the frame, agents reloading web plugins) can be handled with a
  sandboxed iframe, credentials only on Radius pages and no agent-driven plugin reloads while shared. Option C needs
  bundle matching and dependency-closed plugin subsets and hides third-party/edited plugin UI from guests. Recommended:
  keep relaying; revisit vetted bundles when plugins are published packages. Not yet sent to her (the owner may).
- Her PR #11951 (session info as the session's own document, catalog as mirror): reviewed with two comments
  (6737930304: field ownership and pending edits; 6737981289: why `JSON.parse(JSON.stringify())` is wrong, the hot path
  re-sending the whole session list). The later decision in §6 supersedes the pending-edits suggestion; the owner will
  tell her later.
- `apps/p2/docs/plugin-practices.md` (committed, linked from the root AGENTS.md): twelve rules from that review.
- Radius artifacts get organization visibility (owner; phone AGENTS.md and `handoff.md` updated).

## 9. Open items, in order

**Update (end of 2026-11-09, after the handoff):**
- **Host-keyed documents and rows: built and committed** (8a5da3ce6): `defineState({ keyed: Session })`,
  `host(Kind)` columns, host-keyed keyed members `keyed(schema, Kind)`, store schema 3, export/import/delete per address
  coordinated with live owners, older archive tables migrated on import, the kit's per-address data with the server's
  part and step ordering instead of a journal. Reviewed by gpt-6-astra and gpt-6.1-sol; the owner cut overzealous checks
  and the journal (`packages/chord/docs/decisions.md`, the entry's built note).
- **Suspendable work in Durable:** the spec went through five revisions with session c1e54598 and is committed
  (815541a14); c1e54598 builds it in a separate worktree. The host side for p2/p3 is designed in
  `apps/p2/docs/waiting.md` (hook stages, wait records, the wake handoff; committed 2c1d24d6f).
- **Efficiency is a requirement** (`decisions.md`; findings and rules in `efficiency.md`): hundreds of workers, a snappy
  UI. Next: a design note for references sharing one wire hold (owner: "sounds ok" to designing it), then review.
- **Tests are isolated and deterministic** (`decisions.md`), after p2's subagents test race.

0. **Owner's direction at the end of the day:** we are still in idea space; start building things out to find what
   does not work. The base inventory covers worker and server only: **the web and TUI primitives are not discussed
   yet** (next design topic). **Reuse of the app kit is in question:** the owner finds it too big, missing things p3
   needs and full of things it does not; evaluate what p3 really uses (`packages/chord/src/node/app/`) and cut it down.

1. The merged base list is in `base-inventory/merged.md` (17 pieces, three tiers, 15 open questions); the owner reviews it.
2. Done: the suspendable design is committed and being built (see the update above).
3. The UI track (layouts, transcript views, panels, what a session waits on, renderers) after the harness.
4. The agent-operates-the-instance surface (§4): opt-in, descriptions, identity.
5. Discuss the resource model spec as an optional plugin; Cristina's sharing proposal.
6. Earlier open items still standing: Radius single sign-in for relay, gateway and MCP (Armin, Vegard); step 0b of the
   p3 build (server.ts, worker.ts, supervisor.ts); the startup telemetry spec revision.
