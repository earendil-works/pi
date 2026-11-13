# What the Pi Roam base must enable: the merged inventory

Merged by the p3 session (2026-11-09) from `base-inventory-astra.md` (60 product cases, B01-B15),
`base-inventory-sol.md` (39 p2 plugins + 50 products, F1-F14, gaps G01-G11) and `base-inventory-opus.md` (70 cases,
N-/X-/D- pieces), with the owner's decisions of the same day (`../status-2026-11-09.md`, `../decisions.md`), which win
where a report disagrees. IDs in brackets point into the reports (A = Astra U/B, S = Sol P/U/F/G, O = Opus U/N).

Guiding principle (owner): the base offers the smallest set of pieces with which every product below is a plugin.

## 1. Use cases, by theme

All three reports agree that each of these can be a plugin once the pieces of §2 exist. One line each.

- **Personal assistants over chat apps** (iMessage, WhatsApp, Slack, Discord, email, SMS; almost no UI): a connector
  plugin maps external conversations to sessions, delivers attributed input, sends replies with receipts. [A U01-U05,
  O U21-U25, S U03-U06]
- **Orchestrator, Home, inbox:** one conversation spawns and follows background sessions; work reports back as cards;
  a "needs you" inbox across sessions. [A U06-U08, O U26-U29, S U01-U02]
- **Questions, approvals, human in the loop:** asks with typed answers, approvals around tools, review loops, sign-in
  codes, device requests (camera, file). [A U13, U36-U38, O U17-U20, U44, S P18]
- **Bespoke apps:** a triage app (earendil-works triage agent: issue analysis, "continue in a session", accept the
  fix), dashboards, boards, stock lists, a project that becomes its own screen, agent-built views. [A U09-U20, O U31-U36,
  U69, S U07-U12]
- **Coding workflows:** sessions per checkout, diffs and review, worktrees, parallel helpers, PRs and CI cards, LSP,
  browsers and computer use. [A U28-U31, O U37-U43, S P07, P34, P39]
- **Automations:** timers, cron reports, webhooks (GitHub, CI), file and inbox watchers, scheduled sessions, long jobs.
  [A U32-U35, O U1-U6, U64, S U13-U18]
- **Stats, analysis, search, memory:** usage and cost (dsh-context), reading session content (Armin), search across
  sessions, memory and knowledge across sessions, replay and evaluations. [A U39-U41, O U7-U16, U66, S P29, P33]
- **Sharing and teams:** share a session (read, send), Radius guests (Cristina), the team instance on a cloud machine,
  presence, two instances working together. [A U42-U48, O U56-U57, U68, S P32]
- **Discord and other ingress:** a session per channel from a template, starting closed, its own policy extension;
  threads as subagents. [A U21-U23, O U60, S P11]
- **Machines and tools:** environments (local, SSH, sandboxes, VMs), MCP servers, terminals, ports, browsers, hands
  with capabilities. [A U49-U50, O U40-U45, S P13, P20, P22, P35]
- **Surfaces:** voice, mobile PWA, notifications, multi-device continuity, the terminal client with plugins. [A U51-U57,
  O U51-U55, S P37, P38]
- **Data:** whole-instance backups to Radius and restore, export and import of one session, moving an instance.
  [A U58-U60, O U58, U65, S P28]
- **Plugins:** catalog, install, update, rollback, settings, plugin-owned workers. [O U61-U62, S F14]
- **The agent operating the instance** through typed contracts (Armin's orchestrator changing settings). [O U70, A U06]

## 2. The base pieces, named once

Status: **EXISTS** (Chord, kit, Durable or p2 has it; p3 re-exports or adapts), **NEEDED** (a p3 contract or bridge
is missing), **DECIDED** (owner decision today). Coverage counts are the reports' own (A of 60, S of 89, O of 70).

| # | Piece | Host | Status | Coverage |
|---|---|---|---|---|
| 1 | Chord substrate: hosts, objects, references, principals, registries, documents, tables, routines, jobs | all | EXISTS | A 60, S 88 |
| 2 | Session service and catalog | server | NEEDED | A 41, S 52, O 27+16 |
| 3 | Session metadata store | server | DECIDED | (new today) |
| 4 | Harness: extensions registry + filter registry, always-on hooks and wraps by phase | worker | NEEDED | A 33+30, S 67, O 16+25 |
| 5 | Model providers and environments as contributions | worker (env also server, open) | NEEDED | in 4 |
| 6 | One input path into conversations | worker + server adapters | NEEDED | A 45, S 41, O 8+3 |
| 7 | Harness observation and control facade | worker; read-only reader on server | NEEDED | A 41, S 60, O 14 |
| 8 | Wake bridge and liveness | worker + server | NEEDED | A 21, S 49, O 3+7 |
| 9 | Suspendable work in Durable | Durable | NEEDED, designed | (under 10) |
| 10 | Questions: ask, open-question index, answer | worker + server | NEEDED | A 17, O 22 |
| 11 | UI composition: route (kind, id), layouts, views per form, panels, groupings, commands | page, terminal | NEEDED | A 48+33, S 74, O 27+15 |
| 12 | Files and byte delivery; HTTP routes, sockets, authenticators | server | EXISTS | A 21+31, S 56 |
| 13 | Secrets and plugin settings | server | NEEDED | O 21+8, S 49 |
| 14 | Platform bindings: plugin manager, reports, keep-alive, telemetry, store and root bindings | kit | NEEDED | A 8, O 5+2+7, S 14 |
| 15 | Whole-instance backup, restore, single-session export | kit + supervisor | NEEDED, DECIDED format | A, S 25, O 1+ |
| 16 | Ingress for tunnels and a public origin | kit | NEEDED | O 8+, S F8 |
| 17 | The agent's typed surface over contracts | worker | NEEDED, direction | O, A |

### Details

1. **Chord substrate** (EXISTS; `packages/chord/docs/design.md` §3-§17, §23). Re-export through p3's API; no second
   event bus, RPC or lifecycle manager. [A B01-B02, S F1-F2]

2. **Session service and catalog** (NEEDED; p2 `plugins/sessions` is the starting point). One required-root plugin
   owns: `create({ key, origin, config, location, open })` idempotent by key (racing Discord messages make one
   session), `configure`, `archive`, `restore`, `copy`/`fork`, `delete` (p2 has none), list and query (recent activity,
   location, origin), typed **admissions** before each operation (before-create, before-configure, ...) so policy
   plugins can gate them, and the worker-failure state. Setup is complete before the first input runs. Templates,
   projects, channel IDs and business states are other plugins' data. [A B03, S F3/G02, O N-SESSIONS, N-CATALOG]

3. **Session metadata store** (DECIDED): everything about a session needed while its worker is off, under typed
   per-plugin keys; the session store keeps what is only used while the worker runs; never both. Replaces the reports'
   "worker owns content fields, pending edits" proposals [A B03, S P31]: a rename is one server write.

4. **Harness** (NEEDED; owner's design today). One harness extensions object in the worker with two registries: the
   **extensions registry** (Durable extensions as they are: tools, prompt sections, hooks, wraps, tasks) and a **filter
   registry** (cuts what is offered: tools, sections, environments, models; told the session and the conversation).
   Hooks and wraps always apply, whatever a conversation selected (the harness composes so; Durable alone runs only
   selected extensions' hooks, `packages/durable/docs/spec.md:6523`); conversation selection only narrows tools.
   Order: extensions declare a phase (security, transform, observe); wraps nest around the chain. Subagent tool choice
   layers on top (`apps/p2/plugins/subagents/contract.worker.ts` `resolveTools`). This replaces Sol's six per-part
   registries with offer/filter/chain/wrap [S F4/G01] and Opus's single `Limits` registry [O Tier 2 item 6], and agrees
   with Astra's B05/B06 roles. Built-in Durable tasks (generation, tool, compaction) cannot be wrapped by installing an
   extension (`packages/durable/src/harness/registry.ts:7-33`); their hooks are the seam [S G01 caveat].

5. **Model providers and environments as contributions** (NEEDED). Durable takes one `models` and one `env` function
   (`HarnessOptions`); p3 composes them from plugin contributions (several providers, a virtual router; several
   environment kinds with capabilities and placement). Model wraps cover the whole Models runtime, including pi-ai's
   payload, header, response and raw stream callbacks (`packages/ai/src/models.ts`), so stats and cache warming do not
   need private access [S G04, P03]. An environment wrap covers files and shell; it is not confinement. `undefined`
   environment, never a local fallback. [S F4, G07; A B14; O N-ENVS]

6. **One input path** (NEEDED). Every producer (web, terminal, chat connectors, other sessions, automations,
   orchestrators) submits through one typed path with source attribution, request IDs, attachments and busy delivery;
   input hooks may transform, handle or refuse. Passive writes, `continue` and shell commands stay distinct effects;
   the shell is an environment operation with its own gate, not disguised input. [S F6/G03, A B04, O N-INPUT, N-COMPOSER]

7. **Harness observation and control** (NEEDED). A public facade over Durable's conversation API (submit, configure,
   abort, fork, entries, context, watch), the commit signal, task graph, usage, and wake; durable records with cursors
   for indexes (watches fold, they are not an event log). On the server a **read-only transcript reader** (Durable
   `readOnly`, no worker start) and catalog queries for analysis plugins. No central event log: each plugin's worker
   part observes there and pushes to its own server tables. [A B07, S F5, O N-NATIVE, D-OBS, cut "central event log"]

8. **Wake bridge** (NEEDED). The worker publishes Durable's wake state; the server keeps a durable index of next wake
   times; a due wake holds the session's object, which starts the worker. Worker liveness comes from Durable's wake
   state, not from counting live tasks (p2 counts every task: `apps/p2/plugins/status/worker.ts`), so a session waiting
   for a person or a webhook does not keep a process. [A B08, S F12, O N-WAKE, N-KEEP]

9. **Suspendable work in Durable** (NEEDED; designed: `packages/durable/docs/suspendable/`). `suspended` task state,
   signals as memos, `Harness.signal`, tools that suspend and resume, hooks that return child tasks (`afterRun` exists;
   `afterTools`, `onYield` added), no hard-coded limits. Answers O open question 3 and S open question 6.

10. **Questions** (NEEDED). The reports split: Astra calls it a reusable plugin, Opus a core contract. Resolved by the
    owner's direction: the **mechanism** is base (a plugin defines a question kind with payload and answer schemas; a
    tool or hook asks through suspendable work; the worker pushes open questions to a server index; one server method
    answers, starting the worker if needed); **renderers** per form come through the UI registries (#11); the inbox,
    notifications and approval policies are plugins. Questions are state, so late joiners see them. [A B11, O
    N-QUESTIONS]

11. **UI composition** (NEEDED). Page and terminal: a route addressed by `(kind, id)` with `navigate` and deep links,
    `Layouts` (one active; the default sidebar-transcript-panel layout is a plugin), views and renderers per kind and
    form (row, card, detail; questions, tool calls and transcript entries included), panels assembled from several
    plugins, groupings that only show, commands and keybindings, composer extension points, delegation of the PWA
    manifest and service worker. Web and terminal have separate registries; a missing renderer has a fallback.
    [A B09-B10, S F9-F10/G05, O N-VIEWS, N-RENDER, N-COMMANDS, N-PWA]

12. **Files, HTTP, sockets, authenticators** (EXISTS; kit `Files`, `Http`, `Authenticators`). Webhook plugins verify
    their own signatures. [A B12-B13, S F8]

13. **Secrets and plugin settings** (NEEDED). One owner for secrets (encrypted, exported in backups as an opaque blob,
    never to clients or workers in plain form unless the owning plugin decides); plugin-owned settings with schemas,
    no global settings bag. [O N-SECRETS, N-SETTINGS, S F11]

14. **Platform bindings** (NEEDED, kit). Things only the start script holds today: a `PluginManager` (install, apply,
    rollback, state, introspection), `Reports` (onError and process output buffered from start), keep-alive
    contributions, telemetry sinks, and the store and `root` bindings the harness adapter needs. Exposed once as narrow
    typed objects; no "get runtime" escape hatch. [A B15, S G06, O Tier 1 item 3]

15. **Backup, restore, export** (NEEDED; format DECIDED). Whole-instance backup = server store + all session stores +
    files + plugin manifest, in the stores' sync format; kit `exportData`/`importData` today cover workers only
    (`packages/chord/src/node/app/app.ts:751-820`). Restore runs in the supervisor before the server loads. Export of
    one session = its store + its metadata entries; import resolves references to instance things (environment,
    providers); credentials never travel. No live session sync. [A B15, S F13/G08, O N-BACKUP]

16. **Tunnel ingress and public origin** (NEEDED, kit). A plugin (Radius, a tunnel) hands requests, sockets and Chord
    links to the HTTP component with provenance; a `PublicOrigin` contribution gives webhooks and chat callbacks a
    stable URL that survives moving machines. [O N-INGRESS, N-ORIGIN, open question 12]

17. **The agent's typed surface** (direction). One generic surface (list, describe, call) over Chord contracts whose
    methods carry model-readable descriptions and are opted in by their plugin; the agent acts as the session's owner
    on a personal instance; risky calls ask a person (#10). [O U70, A U06]

**Not base (resolved):** a `Policy` provider [O N-POLICY]: permissions are plugins; base-owned services expose typed
admissions (#2, #6, #4 filters and hooks) and that is enough. The resource model spec is one such plugin.

## 3. The minimal set, in three tiers

**Tier 1, restart-bound base (kit and base code).** The API package and its re-exports; the principal kinds (`server`,
`worker`, `user`, `guest`; whether to add `external` is open); host kinds and the worker entry; one root slot per
surface with the route and the PWA delegation (#11's base hooks); the platform bindings (#14); tunnel ingress (#16);
restore in the supervisor (#15); and any Durable change (#9). Everything else is reloadable.

**Tier 2, required-root reloadable core plugins** (absent: dependent work refuses to start; replaceable):
sessions with the catalog, metadata store, admissions and wake index (#2, #3, #8); the harness with its two registries,
model and environment composition, the input path and the observation facade (#4-#7); questions (#10); secrets and
settings (#13); the UI composition registries and the default layout (#11); backup and export orchestration (#15).

**Tier 3, ordinary plugins** (first plugins define their own contracts): the inbox, notifications, approvals and
permission policies, the resource model, templates, projects, groupings, Discord, Slack, WhatsApp, iMessage bridges,
triage, dashboards, canvas, automations and the scheduler, stats, search, memory, MCP, environments' concrete kinds,
terminals, ports, voice, sharing and Radius integration, the agent's typed surface.

**Cannot be plugins** (all three reports agree): principal kinds (facets are typed by the app's principal union);
tunnel ingress (`host.accept` and HTTP `fetch`/`upgrade` belong to the app); restore (the data directory being
restored holds the plugins); the plugin loader and rollback of a broken manager; keep-alive, reports and telemetry sinks
(host options the kit owns); new worker host kinds (start-script options); always-on hooks (only the harness owner can
guarantee them); real isolation (OS, VM or remote services, never a hook); exactly-once external effects (idempotency
keys and receipts instead).

**Cut:** compulsory resources, ACLs, projects, Home, inbox, board or ticket types in base; a public Durable `Extension`
in plugin APIs beyond what the harness object defines; a central event log; a second workflow engine (Chord jobs and
Durable tasks suffice); a stringly action or permission bus; fixed UI slot catalogs per product; mandatory full payload
logging; compatibility with old pi's JSONL paths, jiti loading or mutable event payloads; live session sync.

## 4. Conflicts and open questions

Marked **owner** where only the owner can decide; otherwise a recommendation.

1. **owner: viewer UI for shared sessions.** Relay the instance's own UI (recommended; sandboxed frame, credentials only
   on Radius pages, no agent-driven plugin reloads while shared) versus Cristina's Radius-built bundle. [A open 2, S open 7]
2. **owner: read-only sharing.** Keep a genuinely read-only viewer (recommended: `mayView` without `maySend`), or every
   viewer a full collaborator. [A open 1]
3. **External principal kind.** Add `{ kind: "external"; provider; id; name }` for chat-network users and other
   instances, or keep them as attributed authors of input without principals. Recommended: attributed authors only
   until a plugin needs them to hold objects. [O open 7]
4. **Hook order inside a phase.** Recommended: filters commute, chains run in contributor order with first block wins,
   argument rewrites are revalidated, wraps nest; a plugin needing a fixed position uses a phase. [O open 1, S open 4]
5. **Built-in task gating.** Filter and wrap plugin task definitions; reach built-in generation, tool and compaction
   tasks only through their hooks. Recommended unless a product needs more. [S open 2, G01]
6. **Old boundary hooks.** Mutable `message_end`, exact `turn_end` and `agent_before_settle` have no exact Durable
   equivalent; `afterTools`/`onYield` tasks (suspendable design) cover the needed cases. Recommended: no further
   Durable boundaries until a real plugin needs one. [S open 3]
7. **Environments from the server.** Should environment kinds resolve to capability sets usable by server objects
   (watchers, indexers, PR jobs), not only by a worker's harness? Recommended: yes, through the environments plugin's
   server side. [O open 5, S G07]
8. **Plugin-owned worker kinds.** Heavy plugin work runs on the server process today. **owner:** add a generic plugin
   worker kind, or not yet. [O open 6]
9. **Initial transcripts on create.** `create` with entries (imports, "continue in a session" from triage) versus always
   fork or import. Recommended: fork from a source session or import an export; no free-form transcript injection.
   [O open 8]
10. **Cross-session input.** Home submitting into other sessions and the Discord conversation tool are submissions
    through #6 with the source session as attribution; gates are the harness hooks of the sending session and the
    receiving session's input hooks. [O open 9]
11. **Tool risk annotations.** MCP has read-only and destructive hints; the owner earlier ruled out new fields on tool
    declarations. **owner:** allow one annotations field (as MCP does), or keep policies on tool names. [O open 4]
12. **Secrets in backups.** Back up encrypted secrets with a recovery key, or only references. **owner.** [A open 10]
13. **Stable public URL** across moves: the Radius identity of the instance, not the machine. Recommended. [O open 12]
14. **Streams** for voice, browser live view, computer use: plugin sockets until a second real user justifies a Chord
    byte-channel abstraction. [O open 14, design §23]
15. **Plugin trust in locked sessions.** Every plugin's worker part runs in every session, including locked ones; the
    lock limits the agent, not installed plugins. The install screen says so. [O open 15]

## 5. Acceptance tests the base must pass (merged)

From Astra's ten tests and Opus's and Sol's traps, the cases that prove the pieces:

1. A chat connector alone (no page plugin) receives two duplicate webhooks while the worker is stopped: one admitted
   input, a reply with a receipt.
2. Concurrent first Discord messages create one session from a template, closed until opened, its filters effective
   before the first model request.
3. Home and triage installed independently: triage opens a new session from an analysis; Home follows it; no core
   issue type.
4. A second layout, a machine view and a third-party panel replace the default shell without server changes; a removed
   view falls back.
5. An approval parks a tool (suspended, worker stopped); permission is withdrawn; answering refuses at dispatch,
   including nested code mode calls and direct service methods.
6. A future task survives the worker exiting and the server restarting, and resumes at its deadline with no client.
7. Stats recover complete outcomes from their own cursor; opening the dashboard starts no idle worker.
8. A reader cannot submit or reach a secret; revocation ends live references.
9. Restore a whole instance into a clean machine: schedules, mappings and views come back before external effects are
   enabled; missing plugins and accounts show as repair steps.
10. Export one session, import it elsewhere, resolve its environment and providers, continue it.
