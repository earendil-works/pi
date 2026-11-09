# Pi Roam base inventory — Astra

## Scope and first conclusions

Angle: products and UX variants first, then the runtime and integration mechanisms those products require. This is an inventory of what plugins must be able to build, not a proposal to put each product in the base. `EXISTS` below distinguishes existing Chord/Durable mechanisms or p2 implementations from a stable p3 plugin-facing API; those are not automatically the same thing. `NEEDED` means the p3 exposure or guarantee is missing from the material inspected, not necessarily that the underlying algorithm must be rewritten.

The key product test is replacement, not adding another sidebar item. A plugin must be able to make Home, a triage queue, an inventory application, a dashboard, or no visual UI at all the primary experience. Sessions remain addressable work and history underneath; neither the transcript nor a project/resource model should be mandatory navigation or authority machinery in the base.

The latest direction is exploratory. `apps/p3/docs/direction-pi-roam.md:1–30` explicitly says it is not decided, treats the instance as the trust boundary, retains environments, and leaves session restrictions open. The older resource model is therefore one candidate policy plugin, not the fixed vocabulary every application must import. Likewise Armin's narrow folder-lending promises and Cristina's trusted-viewer bundle are product proposals that need capabilities the base enables; they are not automatically delivered by installing a layout.

## Product evidence that changes the inventory

### Home-first is not just a different transcript renderer

`/tmp/armin.txt` describes one personal Home conversation, independent background work cards, an actionable needs-you inbox, project screens generated from real business data, contextual selection attached to a request, and requests arriving in another person's Home. Its implications are separate session orchestration, observable work state, persistent questions, non-transcript routes, document-backed application state, causal links from changes back to work, and a distinction between a closed card and a stopped worker. A Home plugin can own all those choices if it can call the same session/input services as the default UI.

`apps/p3/docs/coding-flow/index.html:1894–2432` adds line comments on live diffs, editable checkout views, parallel worktrees, cross-machine execution, an interactive terminal used by both person and agent, checkout-local MCP suggestions, explicit publication confirmation, CI follow-up, and a machine detail assembled by independent Files/Terminals/Settings plugins. I read the walkthrough body as text; its styling is not part of this inventory.

### The real triage product is richer than an issue-summary bot

Found `earendil-works/pi-triagent`, inspected at commit `d8c290c70b29b1b5f51d1de1a4df6711a4737e6e`. References written as `triagent:<path>` below mean that repository at this commit, not a file in pi. Its README was read in full, along with the implementation files cited later. Repository: https://github.com/earendil-works/pi-triagent/tree/d8c290c70b29b1b5f51d1de1a4df6711a4737e6e .

Concrete behavior from `triagent:README.md`:

- A 20-minute incremental GitHub corpus sync with an overlap window, special refetch of untriaged closed issues, comments, maintainer attribution and PR metadata.
- An automatically researched inbox distinct from the open-issues list; filters and selected subject live in deep-linkable URLs.
- A structured result, report, duplicates, draft reply, patch and full agent log; edits/comments arriving after research are shown explicitly as unseen input.
- Decisions wait six seconds before publication and can be undone during that window. The server rechecks current GitHub state, and closing the page does not silently discard a pending decision.
- One conversation per research run, research/fix mode-specific tools, user chat that revises saved findings, a concurrency-limited background queue, and interactive replies that bypass that background queue.
- Disposable VMs with no GitHub token, costs/time limits, review subagents, captured patches, and optional fix restoration into a later VM.
- A human-confirmed server-side Open PR operation using separate credentials; repeatable publication steps and a distinction between local decisions and upstream side effects.
- Continue in pi exports history with an explicit environment-change note. It does not pretend the disposed VM, its files or its tools came along.

This demonstrates why the base needs typed tools with structured UI/program outputs, durable task/input orchestration, observation and application-owned state. It does **not** justify putting GitHub, triage categories, six-second undo, a fix queue, an approval database or VM allocation in the base.

### Sharing has a real product conflict, not merely a missing ACL

`/tmp/cristina.md` proposes Radius-owned share landing pages, anonymous/read-only visitors, account switching, offline explanations and per-brain origins; crucially, Radius-built viewer UI rather than arbitrary code supplied by the shared instance. The Roam direction instead emphasizes fully extensible instance UI relayed through Radius. Those can coexist only with an explicit distribution choice: trusted built/signed plugin code, an owner-only custom UI with a reduced viewer UI, or accepting instance-supplied viewer code in an isolated origin with clearly stated trust. A generic Chord renderer registry cannot make arbitrary third-party JavaScript trusted.

The proposal also preserves the distinction between session access and external-account login, and between content routes and executable UI routes. Do not flatten these into a single session-share token or claim that an iframe origin alone prevents deceptive UI.

### Groupings and views are an explicit requirement

The source is `apps/p3/docs/decisions.md:42–56`: the owner's discussion with Christian, Max and David, relayed by session cbe4592b. It requires plugin-defined group kinds containing any addressable thing, independent headers/extras, views for non-session targets, layouts as plugins, and agent-composed views. I did not inspect the off-disk sidebar artifact. Inferences below are labeled as proposals, not quotations from Christian.

I also read the nineteen concept captions and the inbox/board examples in `apps/p3/docs/layouts/mocks.html`: inbox, run board, mission control, environment, repo/day timelines, replay, room, project dashboard, gallery, canvas, traces, decisions, plans, knowledge graph, calendar/mail, voice, terminal tiling, ambient notifications. These are useful stress cases. In particular, replay of a past terminal or browser needs captured historical data; a live watch alone cannot reconstruct it.

## Use-case inventory

Each case has two user-experience sentences, a concrete plugin construction, and its direct base dependencies. IDs resolve to the typed definitions and source citations in the final merged inventory; the status in each case is the status of that **p3-facing piece**, not a claim that p3 already implements its underlying library. Every case also needs **B01 [EXISTS]**, Chord's plugin/object/registry/lifecycle substrate. Dependency counts later count each case once per piece; they are coverage counts, not estimates of engineering effort.

Legend: B02 persistent application state; B03 sessions service; B04 conversation control; B05 independent harness-part registries; B06 execution and operation interception; B07 harness observations; B08 worker/wake bridge; B09 replaceable UI shell and navigation; B10 typed targets/groupings/views; B11 question and client-request bridge; B12 authenticated HTTP/Chord transports; B13 files and byte delivery; B14 execution environments; B15 process-owned platform bindings and portable data operations.

### Personal assistants and work coordination

#### U01 — iMessage personal assistant

**Experience.** The owner texts Pi a question or a photograph and receives a normal reply in the same conversation. A long-running request produces a short progress update and a later result without requiring the Pi page to stay open.

**Plugin.** A server plugin owns an authenticated bridge to a Mac-side iMessage adapter, records external-message IDs, and maps a thread to a session. It calls session creation and input submission, follows committed responses, and records outbound delivery attempts; the session worker owns reasoning and tasks. Access to iMessage itself is an OS/integration requirement, not something a browser plugin can conjure.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B08 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U02 — WhatsApp assistant with voice notes

**Experience.** A user sends a voice note or document in WhatsApp and gets an answer there. Pi can ask a follow-up question and preserve the thread when the phone disconnects.

**Plugin.** The server adapter validates provider webhooks, stores message/delivery IDs and attachments, and submits normalized content to a mapped session worker. Speech providers and outgoing media formatting are plugin choices; durable questions are rendered as chat replies or provider buttons rather than web-only dialogs.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B08 [NEEDED], B11 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U03 — Discord channel creates a closed session from a template

**Experience.** The first eligible message in a configured channel creates its Pi conversation automatically. It runs without appearing as an open tab; the owner can later open its full transcript and change its permitted tools.

**Plugin.** A server gateway object owns the connection, channel/thread mapping, dedupe and a versioned template. It creates/configures the session before admitting input; a worker policy plugin filters tools/sections/models/environments and checks execution through hooks/wrappers. A page plugin optionally supplies the channel's own transcript and grouping; opening is a per-user UI preference, not permission to run.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS].

#### U04 — Slack team assistant

**Experience.** A team mentions Pi in a Slack thread and receives a scoped answer with links to work it performed. A follow-up in the same thread continues that work rather than creating an unrelated chat.

**Plugin.** The server adapter owns Slack installation credentials, event verification, thread routing and outbound receipts. Worker tools implement repository/internal-system access; the integration's own policy decides which thread can address which existing session and whether a mention, command or every message starts work.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B12 [EXISTS].

#### U05 — One assistant across several chat apps

**Experience.** The owner starts a task in iMessage and checks it later in Discord or the web page. Pi does not accidentally merge a public channel into the owner's private conversation because the displayed names match.

**Plugin.** An identity/routing plugin owns explicit account associations and maps verified connector identities to chosen work targets. Separate connectors call its typed methods; observations fan out through an outbox with per-destination receipts and loop suppression. Conversation context, viewer access and delivery destinations remain different facts.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B06 [NEEDED], B07 [NEEDED], B12 [EXISTS].

#### U06 — Armin's Home-first entry point

**Experience.** The first screen is one question and one input, with no empty project tree. Pi chooses a place for substantial work, shows a changeable place chip, and keeps Home available for quick unrelated questions.

**Plugin.** A Home page plugin replaces the root layout and owns per-user navigation preferences. Its worker orchestration tools call the server session service, store parent/child and project links in plugin state, submit work, and turn observations into concise cards; choosing a project is orchestration policy rather than a base router side effect.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED].

#### U07 — Background helpers and one consolidated result

**Experience.** One request launches several helpers while the user continues talking to the coordinator. Pi combines their findings and asks only for the unresolved decision, with each helper's transcript still available.

**Plugin.** A worker plugin registers a task definition and orchestration tools, creates owned child conversations or separate sessions as isolation requires, and waits on their durable receipts. The server holds only the workers that need to run; parent ownership, background cancellation and explicit detach are represented rather than inferred from open tabs.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED].

#### U08 — Cross-session needs-you inbox

**Experience.** Questions, failed work and completed deliverables arrive in one actionable inbox. Answering a card resumes the right work without navigating to its transcript, and another device immediately sees that the question was answered.

**Plugin.** An inbox server store indexes references to question/work objects and owns read, snooze and assignment state; it does not copy the question's authoritative answer state. Page and terminal facets render the same sources, and answer methods validate the still-open question revision. The plugin ranks urgency and decides which completions merit a card.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED].

### Bespoke applications, dashboards and composition

#### U09 — Roastery inventory becomes the primary screen

**Experience.** The owner points Pi at a spreadsheet and gets a stock list, not another permanent chat tab. Asking for a roast log adds a domain-specific screen, while the conversation remains one level down.

**Plugin.** A business-app plugin owns inventory/order tables, spreadsheet import/sync, schema migrations and typed methods. Its page facet contributes a target view with stock/order/roast panels; its worker tools call the same methods, and files remain in the spreadsheet environment or managed storage according to the plugin's explicit ownership choice. Generating new executable plugin code is a separate install/apply action, not ordinary model output.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS], B14 [NEEDED], B15 [NEEDED].

#### U10 — Ask about a selection and explain a change's origin

**Experience.** Selecting two coffee lots and asking “reorder these” acts on those lots, not whatever a hidden chat happened to mention. Clicking a stock change reveals its invoice and the work that produced it.

**Plugin.** The page serializes typed target references and selected record/version IDs into an input attachment; the worker resolves fresh permitted state before acting. The domain store records an operation's source session, submission/entry and source file IDs alongside the change, so provenance is real data rather than a reverse search over prose.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS].

#### U11 — Daily triage inbox inside Pi Roam

**Experience.** A maintainer opens an inbox grouped by suggested action, reviews the report, duplicates and changed comments, and accepts or overrides the recommendation. The issue, not its chat transcript, is the main object on screen.

**Plugin.** A server triage store owns corpus, issue state, recommendations and queue; each research unit uses a session worker with registered tools and a disposable environment. Page facets supply URL-addressable issue views, filters and keyboard actions, while structured tool results update the triage store and link to the complete conversation. Existing behavior: `triagent:README.md:3–27,177–199`; queue/tool selection: `triagent:src/agent-runs.ts:416–574`.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B14 [NEEDED].

#### U12 — Pull an issue analysis into personal work

**Experience.** “Continue with Pi” opens a new editable session containing the analysis and relevant patch. The UI says which repository/environment will now be used and does not imply that the old disposable VM is still present.

**Plugin.** The triage server calls a session copy/seed operation with an explicit source snapshot, attaches the report/patch, and applies a destination configuration before input is enabled. A handoff entry states changed tools, environment and missing files; permissions and connector bindings are deliberately not cloned by default. The existing export implementation is `triagent:src/pi-session.ts`; p2's transfer contract is `apps/p2/plugins/sessions/contract.ts:354–391`.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS], B14 [NEEDED].

#### U13 — Accept a proposed fix directly

**Experience.** A reviewer checks a diff, edits the PR text and explicitly opens the proposed PR. If publication partly fails, retry finishes the remaining steps rather than launching a second research run.

**Plugin.** The triage page invokes a typed server publication method; a persisted job validates the selected patch/base revision, pushes through the server's connector, finds-or-creates the PR and records its receipt. The VM never receives the publishing token. This separation is concrete in `triagent:src/fix-pr.ts`, not a reason to give every tool access to every instance credential.

**Needs:** B02 [EXISTS], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B12 [EXISTS], B13 [EXISTS], B14 [NEEDED].

#### U14 — Triage sync, stale-input warnings and reversible pending decisions

**Experience.** A maintainer sees comments that arrived after the agent's research and can reconsider its stale recommendation. A just-made decision offers a short undo window, then clearly reports whether GitHub actually accepted it.

**Plugin.** A server routine persists sync cursors and remote revisions; a page marks differences from the exact research input snapshot. A decision job owns a pending deadline, cancellation and publication receipt, and rechecks upstream state at execution. Undo after publication is a new compensating operation if the product offers it, not a local deletion pretending to undo GitHub.

**Needs:** B02 [EXISTS], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS].

#### U15 — Mission control and operations dashboard

**Experience.** A second monitor shows active work, failing connectors, costs and questions across the instance. A user opens a tile or acts on a failure without first searching a session list.

**Plugin.** A server aggregator maintains bounded summary rows from session reports and optional connector status contributions; it never holds every worker merely to draw idle tiles. Page panels hold detailed worker views only while expanded. Health/urgency definitions and layout are entirely plugin-owned; kit runtime health and domain status remain distinguishable.

**Needs:** B02 [EXISTS], B03 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED].

#### U16 — Usage, context and cost explorer

**Experience.** The owner sees spend by day, model, project and helper family, then drills into the requests that consumed it. A context view explains what the next request contains and how compaction changed it, without pretending estimated token allocation is exact billing.

**Plugin.** A worker observer projects committed usage and context events to a server statistics store with stable event keys; page/terminal facets render totals, charts and a command. Context-inspection hooks can record request snapshots according to an explicit privacy policy. This resembles the inspected [dsh-context README](https://github.com/bowenliang123/dsh-context/blob/main/README.md) insights/context/fleet views, while Durable supplies the raw observations and usage rather than dsh's projections.

**Needs:** B02 [EXISTS], B03 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED].

#### U17 — Independent groupings of arbitrary things

**Experience.** Recent work, folders, a project and Discord channels can each show the same session without moving it or changing what it may access. A grouping can also contain a machine, file or MCP connection and render its own header and controls.

**Plugin.** Each server plugin owns its grouping query or curated membership and exposes rows of typed targets. Each page/terminal facet contributes a grouping kind, its rendering and navigation actions; the chosen layout composes those groups without requiring a canonical tree or one parent per target. Source: `decisions.md:42–56`; display membership grants nothing in `resource-model/book.md:625–659`.

**Needs:** B02 [EXISTS], B03 [NEEDED], B09 [NEEDED], B10 [NEEDED].

#### U18 — A machine, not a conversation, as the main view

**Experience.** Opening slayer shows its files, terminals, settings and current work. A later plugin adds a VNC panel without rewriting the machine plugin or forcing a transcript into the center.

**Plugin.** The environment plugin exposes a machine target and status; Files, Terminals and a future desktop plugin independently contribute panels for that typed target. They call the environment's methods or their own guarded backends, and the worker reports which work uses it. The machine's UI does not gain access merely because its renderer was registered.

**Needs:** B02 [EXISTS], B03 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS], B14 [NEEDED].

#### U19 — Board, timeline, gallery, room or canvas instead of sidebar/chat/sidebar

**Experience.** One person uses a run board, another a gallery, and another a canvas containing live objects from several plugins. Their layout choice changes presentation, not the underlying work or who may operate it.

**Plugin.** Page/terminal layout contributions consume target views and observable records; the server persists each user's or project's layout configuration. A board calls real retry/submit methods, a room uses presence plus explicit membership, and a canvas stores typed relations/selection. Historical timeline/replay features additionally record events/snapshots; they cannot recover unrecorded screen state from current watch values.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS].

#### U20 — Agent-composed views

**Experience.** “Show this project's failing jobs, open questions and monthly spend” assembles a useful view from installed pieces. The user can edit or discard that composition without changing the underlying plugins.

**Plugin.** A worker tool writes a schema-checked composition document containing registered view/panel identities, typed targets and layout parameters. The page resolves those contributions and shows explicit unavailable panels when a plugin is absent. Generating arbitrary JavaScript instead is a different trusted-plugin installation path; it cannot inherit the safety properties of selecting existing components.

**Needs:** B02 [EXISTS], B05 [NEEDED], B09 [NEEDED], B10 [NEEDED].

### Sharing, collaboration and team instances

#### U21 — Read-only session sharing

**Experience.** A recipient follows a link and reads a session and its intended attachments without acquiring the owner's tools or configuration controls. Revocation ends further access and clearly changes the page to an access-revoked state.

**Plugin.** A sharing server store owns grants and their revisions; authenticators establish viewer identity and remote objects expose reader variants with redacted state. Page and terminal facets render those variants, while content routes apply equivalent access checks. Read-only sharing is a deliberate alternative to the broad trust in the Roam notes, not something hiding the input editor proves.

**Needs:** B02 [EXISTS], B04 [NEEDED], B06 [NEEDED], B09 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U22 — Signed-in collaborator can ask Pi

**Experience.** A named collaborator joins shared work, sees who is present and submits messages. The invitation states which configured environment and accounts the shared session can reach, regardless of whose message starts a run.

**Plugin.** The server sharing plugin authenticates the collaborator, exposes the permitted session view and stamps authorship at input admission. A worker runs the session's configured policy, not a new per-message authority model; presence is connection state, while membership and grants are persisted application data. Controls such as archive, raw file access and model reconfiguration need their own server checks.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B06 [NEEDED], B09 [NEEDED], B12 [EXISTS].

#### U23 — Radius guest landing and account recovery

**Experience.** A recipient can distinguish “wrong account,” “sign in,” “continue as guest,” “link revoked,” and “owner's machine offline.” Following an invitation returns them to that invitation after account switching instead of losing the target.

**Plugin.** Radius owns landing/auth/account-switch UI and relay identity assertions; the instance sharing plugin owns authoritative grants and publishes only the metadata Radius needs while the instance is offline. The authenticated relay establishes a Chord principal, not a client-supplied author string. Anonymous versus signed-in write access is sharing policy, as proposed in `/tmp/cristina.md:65–102`.

**Needs:** B02 [EXISTS], B03 [NEEDED], B06 [NEEDED], B09 [NEEDED], B12 [EXISTS].

#### U24 — Safe viewer bundle versus fully custom instance UI

**Experience.** The owner gets the instance's customized interface through Radius. A shared viewer either gets vetted code capable of rendering that work or a clear unsupported-view message, not an unnoticed fallback to arbitrary owner-supplied scripts.

**Plugin.** A Radius/surfaces integration publishes a versioned plugin/contract manifest, chooses a compatible bundle and transports Chord/content separately. Per-instance origins, CSP and sandboxed artifact content are enforced by the HTTP/hosting layer; the plugin decides supported viewer components and fallback. Cristina's proposal requires Radius-side implementation and a distribution agreement, not just a p3 plugin.

**Needs:** B02 [EXISTS], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS], B13 [EXISTS], B15 [NEEDED].

#### U25 — One preconfigured team instance

**Experience.** Fifteen to twenty teammates share a persistent Pi instance with the same configured repository, mail and internal-system access. Each sees personal recents and read marks, while team work can start from Discord or the page.

**Plugin.** Provisioning installs the instance and selected plugins; a team plugin owns membership, shared templates and default views, while external login plugins own account credentials. The server/session services handle concurrent callers and per-user preferences separately from shared work. A shared instance does not silently promise confidential per-person secrets against its administrator or installed server code.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS], B15 [NEEDED].

#### U26 — A smaller trust circle gets another instance

**Experience.** Finance or a small project group gets a separate Pi instance rather than a complicated hidden compartment in the large team instance. Radius lists both and makes their identities unmistakable.

**Plugin.** A provisioning service creates an OS/container/VM boundary and installs a chosen plugin/configuration set; a Radius plugin connects it and a fleet page navigates between instances. Import/export supplies approved seed data, not an implicit copy of all credentials and grants. This product needs deployment infrastructure outside the instance in addition to plugins inside it.

**Needs:** B02 [EXISTS], B03 [NEEDED], B09 [NEEDED], B12 [EXISTS], B15 [NEEDED].

#### U27 — Shared project with its own screen and work

**Experience.** Cristina opens Roastery, edits its stock view and asks Pi about its orders without seeing another person's Home. The invitation names the project's visible work and the accounts/environments it permits.

**Plugin.** A project plugin owns membership and target grouping; a policy plugin derives admitted session tools/environments and server views from that membership and configuration. The project's page layout is independent of its policy. The old one-resource-list model can implement this, but ordinary display-only project grouping must not force its installation.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS].

#### U28 — Lend a folder or machine for one task

**Experience.** Pi asks the machine's owner for a particular folder or environment, explaining the requester and purpose. An active chip offers Stop, and the lease ends when the defined work finishes or its deadline expires.

**Plugin.** A server lending plugin owns the lease and a durable question; worker environment/tool gates check current admission at use and reconcile withdrawal independently of open pages. A confined environment adapter enforces actual filesystem/process boundaries. An unrestricted shell on the same machine cannot honestly satisfy “only this folder, read-only”; `cwd` and a filtered tool list alone do not provide that isolation.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B14 [NEEDED].

### Coding, automation and policy

#### U29 — Parallel coding worktrees on different machines

**Experience.** Pi investigates three failing tests in separate checkouts and presents a combined result. One helper runs on the build machine while the others stay local, without overwriting each other's files.

**Plugin.** A coding orchestration worker contributes tools/tasks that allocate worktrees through an environment service and create configured child sessions. It records the relationship between work, checkout and machine, cleans up through durable jobs, and reports summaries to Home. Worktree allocation and merging are coding-plugin behavior, not base session creation side effects.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B14 [NEEDED].

#### U30 — Live diff review and line comments

**Experience.** A user reviews current changes like a PR, comments on a line and asks for a revision. Accepting the diff is visibly different from committing or pushing it.

**Plugin.** A workspace worker exposes guarded file/status/diff operations and change revisions; page components render them and submit comments with file/hunk/revision anchors to the work conversation. A coding policy inserts publication approval at the actual push method/tool boundary. `apps/p2/plugins/workspace/contract.ts` is an existing contract reference, not a guarantee of every proposed review action.

**Needs:** B02 [EXISTS], B04 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B14 [NEEDED].

#### U31 — Human and agent share an interactive terminal

**Experience.** The user opens the exact terminal Pi is using and can type into it. Resizing or closing that view does not secretly create another shell or cancel unrelated work.

**Plugin.** A terminal backend owns PTY lifetime and command/input attribution, using an environment-specific adapter and an authenticated socket for bytes. Worker tools and page/TUI panels address that same terminal; bounded state summaries link it to work. A socket already exists in kit HTTP, so a new Chord stream primitive is not necessary to build the product.

**Needs:** B02 [EXISTS], B05 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B12 [EXISTS], B14 [NEEDED].

#### U32 — CI failure creates follow-up work

**Experience.** A failed check appears beside the earlier fix, and Pi begins a follow-up on the right branch. Publishing a second change follows the same confirmation rules as the first.

**Plugin.** A server webhook adapter verifies signatures and deduplicates run/check IDs into durable events. An automation plugin creates or addresses a session from its stored repository/branch association, holds the worker, submits the event and records completion; coding tools and policy perform diagnosis/publication.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B12 [EXISTS], B14 [NEEDED].

#### U33 — Timed recurring work

**Experience.** “Check security advisories at six every morning” runs even when no browser is open. After downtime, the UI explains whether a missed occurrence was skipped, caught up or combined.

**Plugin.** A server scheduler persists schedules, timezone rules, occurrence IDs and missed-run policy; it creates/configures work and registers Durable tasks where appropriate. The runtime bridge persists future wake information outside idle workers and holds their objects when due. Cron parsing, recurrence semantics and overlap policy remain plugins.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED].

#### U34 — Event workflows and dependency graphs

**Experience.** Finishing one analysis starts the next stage, while a failed prerequisite blocks dependent work with an explanation. Cancelling a workflow names which background branches continue and which are stopped.

**Plugin.** A workflow worker contributes versioned task definitions with durable waits/sleeps and explicit ownership; a server store indexes workflow summaries and input event receipts. The page renders the graph from observations, never from an in-memory Promise chain. Cross-system effects use plugin-defined idempotency/reconciliation, not a claim of universal exactly-once execution.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED].

#### U35 — Scheduled reports and digests

**Experience.** Each Friday the team receives a concise report with links to completed work and unresolved decisions. A retry does not send a duplicate report to every channel.

**Plugin.** A scheduler starts a report worker with chosen query/tool registrations; its result is a managed artifact and structured summary. A server delivery outbox owns per-destination receipts and retry policy, while the schedule and report inputs are persisted for audit. Formatting for email, chat and the page is adapter behavior.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U36 — Budgets, rate limits and economical routing

**Experience.** A project receives a warning before exhausting its daily budget and can pause work or switch to a cheaper model. The UI distinguishes measured usage from estimated remaining exposure in concurrent requests.

**Plugin.** A policy server owns shared accounting/reservations; worker model/tool hooks reserve before dispatch, settle from committed usage and abort or block further calls when required. Model selection can route to cheaper providers through the Models part. Observations alone cannot provide a strict cap, and final streaming spend may remain uncertain despite admission reservations.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B11 [NEEDED].

#### U37 — Persistent human approval

**Experience.** Pi pauses before sending a purchase order or pushing a change, and the user answers later from another device. A stale approval cannot authorize a different action after the parameters changed.

**Plugin.** An approval plugin persists a question containing the proposed operation identity, arguments digest/revision, audience and deadline. A hook/task waits durably and rechecks authorization and the operation revision before invoking the effect; page, TUI and chat adapters call the same answer method. The approval service is an ordinary plugin built from state/jobs/tasks, not a magical process-local callback.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B11 [NEEDED].

#### U38 — MCP connectors and checkout-local suggestions

**Experience.** A user connects a tool server or approves a tool suggested by a checkout. Its available tools update live, and another checkout does not silently inherit a local executable or its login.

**Plugin.** Server/worker MCP owners manage transports and login state according to placement, dynamically contribute Tools and Sections, and publish their own connection target/status. Environment-scoped suggestions are discovered by a plugin and approved against their content revision. A page contributes configuration and status panels; MCP is not a base resource kind.

**Needs:** B02 [EXISTS], B05 [NEEDED], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B12 [EXISTS], B14 [NEEDED].

#### U39 — Code mode and nested tool calls

**Experience.** Pi writes a small script to compose several installed tools and returns a concise result. Tools hidden from the model can remain callable from the script, while disallowed tools remain unavailable everywhere.

**Plugin.** A worker contributes the code-mode tool and owns its sandbox native. Nested calls go through the harness's typed execution API, with structured results, progress and the same execution gates; the script never receives a privileged bypass to an underlying tool implementation. Durable already distinguishes model-visible `tools` and nested `callable` tools and executes nested calls as tool tasks.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B14 [NEEDED].

#### U40 — Untrusted research in disposable sandboxes

**Experience.** Pi can investigate an issue, attachment or unfamiliar repository without handing it the host's credentials. When its VM is replaced, Pi says what state was lost and restores only explicitly retained artifacts.

**Plugin.** An environment plugin owns VM/container allocation, network restrictions and teardown; worker tools run through that environment, while a server connector performs privileged publication separately. Persisted patch/checkpoint metadata drives restoration. A local process with a different `cwd` is not a sandbox, and cancellation must actually stop guest processes or report its limits (`triagent:src/agent-runs.ts:703–710`).

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B13 [EXISTS], B14 [NEEDED].

### Additional products and interfaces

#### U41 — Voice-first Pi

**Experience.** The phone acts like a radio: Pi speaks one question or result at a time and accepts an interrupted spoken answer. The user can tap through to the underlying work when speech is insufficient.

**Plugin.** A page/native client captures audio under platform consent; server/worker speech adapters transcribe, submit normal input and synthesize selected output. Question answers carry stable question IDs, and barge-in explicitly cancels playback or a run according to product policy. Audio transport uses managed files or sockets, not transcript text polling.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B09 [NEEDED], B11 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U42 — Mobile capture, lock-screen actions and ambient widgets

**Experience.** A person shares a photo or document to Pi and later answers a needs-you notification without hunting for a session. A notification that has expired opens the current question rather than executing an obsolete action.

**Plugin.** A native companion, PWA or browser extension supplies OS-specific capture/notification integration and invokes authenticated server methods. A page/client-request adapter uploads files, submits target context and answers a revisioned question; a server notification plugin owns subscriptions and delivery receipts. An installed web facet alone cannot add every platform's share extension or background service capability.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B09 [NEEDED], B11 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U43 — Terminal-first or tiled TUI

**Experience.** An SSH user operates sessions, questions, terminals and logs with configurable keys in a tiled interface. A graphical-only panel has a useful link or textual fallback instead of breaking the whole application.

**Plugin.** Terminal facets contribute layouts, views, commands and keybindings using the kit's launcher/scope and the same server contracts as the page. Per-user layout preferences and draft input persist independently of component remounts. Opening local URLs, attaching files and clipboard access go through the trusted launcher/client boundary, not unrestricted downloaded terminal code.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B12 [EXISTS], B15 [NEEDED].

#### U44 — Browser assistant and visible browser automation

**Experience.** A user sends the current page selection to Pi or watches the browser Pi is driving. Screenshots and downloads remain linked to the work that produced them.

**Plugin.** A browser extension can answer explicit client requests; alternatively an environment plugin owns a server-side browser native. Worker Tools register navigation/inspection actions and a page panel renders screenshots or a separately transported stream. Browser login profiles, allowed sites and confirmation for purchases belong to that plugin's policy.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B12 [EXISTS], B13 [EXISTS], B14 [NEEDED].

#### U45 — Search everything and jump to the right object

**Experience.** A user searches a phrase and finds relevant sessions, artifacts, files and domain records. Opening a result lands on the matching entry or object view, not necessarily a chat root.

**Plugin.** Search owns a rebuildable derived index, consumes paged authorized source APIs and commit/changed-record signals, and stores scan checkpoints. Worker index adapters report relevant entries without exposing other plugins' raw stores; page/TUI contributions render results as typed targets. Cold/archived sessions need an explicit read/index path, not an accidental run resume.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS].

#### U46 — Long-term memory and decisions graph

**Experience.** Pi remembers selected project facts and can show the source and later correction of a remembered decision. The owner can inspect or delete memories rather than trusting an invisible summary appended forever.

**Plugin.** A memory plugin owns records, provenance, retention and derived search/graph indexes; worker hooks extract candidates after committed work and Sections retrieve the permitted ones for a request. Page tools expose review/correction/deletion, with supersession represented explicitly. Durable context compaction and application-wide memory have different lifetimes and must not share one implicit state bucket.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED].

#### U47 — Radius backup and restore onto a fresh machine

**Experience.** The owner connects Radius, sees backup progress and restores the instance after replacing a machine. Pi explains missing external machines, plugin packages and logins instead of claiming the backup recreated the whole operating environment.

**Plugin.** A server backup plugin consumes consistent store export/outbox facilities and managed-file manifests, uploads encrypted snapshots/batches and tracks checkpoints. A provisioning/import workflow restores to unused addresses, reinstalls matching plugin versions and reconciles external references before resuming automation. Radius transport, encryption/key recovery and restore policy are plugins/services; exposing the app-owned stores safely is a platform seam.

**Needs:** B02 [EXISTS], B03 [NEEDED], B08 [NEEDED], B12 [EXISTS], B13 [EXISTS], B15 [NEEDED].

#### U48 — Multi-device continuity and honest offline mode

**Experience.** The user switches between laptop, phone and terminal and sees the same work, while each device keeps its own transient navigation. Offline reading or drafted messages are visibly offline and do not imply that the agent ran locally.

**Plugin.** Client surfaces reconnect to the same typed objects; a preferences/drafts plugin stores chosen shared or device-local state and submission keys. Optional offline replication uses read-only snapshots and a queued-input outbox whose admission is rechecked after reconnect. Chord links re-hold state but do not replay failed in-flight methods, and read-only Durable copies cannot execute work.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B09 [NEEDED], B12 [EXISTS], B13 [EXISTS], B15 [NEEDED].

#### U49 — Custom providers, virtual models and failover

**Experience.** A user selects a company model gateway or a virtual “fast” model without changing the rest of Pi. The UI records which actual model answered and distinguishes authentication failure from a rate-limit retry.

**Plugin.** Model plugins own catalog entries, credentials/refresh and routing; worker Models contributions provide the current resolver and request wrappers, with selection separate from secrets. Observations record physical model, attempt and usage, and the page provides login/configuration flows. This covers old `registerProvider` and `registerVirtualModel` demands without exposing Durable `Extension`.

**Needs:** B02 [EXISTS], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B11 [NEEDED], B12 [EXISTS].

#### U50 — Custom prompts, skills, input modes and compaction

**Experience.** A project can load its own instructions, templates and skills, and a user can choose how long conversations are summarized. A command that is handled locally does not also leak into the model as an accidental second request.

**Plugin.** Worker plugins contribute Sections, Input handlers, tools and compaction/request hooks; environment watchers discover checkout files and refresh contributions. Page/TUI facets contribute command completion and controls, while the input chain produces an explicit handled/transformed/rejected outcome. The old extension lifecycle is a catalogue to preserve, not the exact new ordering contract.

**Needs:** B02 [EXISTS], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B14 [NEEDED].

#### U51 — Install, configure and hot-reload a plugin product

**Experience.** The owner installs a business app or edits its UI and applies it without losing draft input or ongoing work. A missing or incompatible plugin leaves a readable failed/unavailable state rather than silently discarding its records.

**Plugin.** A management page calls exposed kit plugin install/apply controls and shows dirty/install/set/base marks; each plugin owns its configuration and versioned documents/contracts. Runtime owners are small native-owning objects and consumers resolve current registry entries at use. Package trust, restart-required changes and migration failures remain visible instead of being hidden behind an unconditional refresh.

**Needs:** B02 [EXISTS], B03 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B15 [NEEDED].

#### U52 — Audit, retention and redacted exports

**Experience.** An administrator can explain who requested an action and which configured account executed it, and can apply retention rules to reports and histories. A redacted share/export excludes secrets without pretending that deleting a local message retracts bytes already delivered elsewhere.

**Plugin.** Server/worker audit plugins consume authenticated operation facts and committed outcomes, writing their own append-oriented records and receipts. Retention reconcilers call owning services' deletion/archive APIs; redaction is applied to exported data and per-principal views, not merely CSS. A tamper-resistant audit against the instance administrator requires an external trust boundary.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B12 [EXISTS], B13 [EXISTS].

#### U53 — Support desk with human takeover

**Experience.** Incoming support messages become cases with a proposed answer and supporting evidence. An operator can take over the conversation or send the draft after editing it, with no duplicate automated reply.

**Plugin.** A server connector owns tickets, message dedupe and a case state machine; worker sessions research with scoped tools and emit structured drafts. A bespoke page exposes case views and a durable handoff/approval state that gates the outgoing server job. Ticket assignment and service-level rules are domain plugins, not base session statuses.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED], B12 [EXISTS].

#### U54 — Mail/calendar concierge

**Experience.** The owner asks Pi to find time, draft a reply or prepare a meeting brief. Sending mail or modifying an event is visibly distinct from reading calendars and drafting text.

**Plugin.** Login/connectors own account-specific credentials and expose typed read/write tools plus their own server methods. Worker orchestration uses those tools, approval hooks pause external writes, and server watch/schedule routines create follow-up work; the page may show a calendar rather than chat. External-provider OAuth is not Pi session authentication.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B08 [NEEDED], B09 [NEEDED], B11 [NEEDED], B12 [EXISTS].

#### U55 — Tutor with exercises and a learner model

**Experience.** A learner works through an exercise screen while Pi asks one question at a time. Progress resumes on another device, and the explanation transcript remains available without dominating the lesson.

**Plugin.** A tutor store owns exercise state, answers and learner progress; page/terminal views render the lesson and worker tools update it through typed methods. Durable questions or normal submissions resume the right exercise, and Sections retrieve permitted learner context. Grading, lesson sequencing and accessibility-specific presentation are plugin behavior.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B09 [NEEDED], B10 [NEEDED], B11 [NEEDED].

#### U56 — Data analysis with durable outputs

**Experience.** A user uploads a dataset, gets charts and a report, and can ask why a particular row was excluded. Rerunning after a changed input produces a new result version linked to its exact inputs.

**Plugin.** A server data-app store owns dataset/run metadata and managed-file references; worker tools run transformations in a selected environment and persist structured results. Page contributions render tables/charts, while jobs/tasks handle long imports and provenance. Database connectors and notebook engines remain plugins rather than new core storage types.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS], B14 [NEEDED].

#### U57 — Replay and evidence-rich incident review

**Experience.** An operator scrubs through a finished run and sees the files, terminal output and browser screenshots that were actually captured at each step. Missing captures are marked as missing instead of fabricated from the current workspace.

**Plugin.** Worker observation hooks correlate entry/task IDs with explicitly captured file revisions, terminal chunks and screenshots in managed files. A replay page builds a timeline over those records; a retention policy bounds capture cost and sensitivity. Full historical request payloads and captures are opt-in plugin persistence, not a mandate for the base to record everything.

**Needs:** B02 [EXISTS], B04 [NEEDED], B06 [NEEDED], B07 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS], B14 [NEEDED].

#### U58 — Restricted research or compliance mode

**Experience.** A session can use only approved models, tools, machines and peer conversations. Trying the same forbidden action through code mode, an old queued tool call or a direct UI button does not make it succeed.

**Plugin.** A policy server owns current restrictions and exposes authorized views; worker filters constrain offered parts, chains check queued/nested execution and wrappers constrain environment/model behavior. Base-provided direct operations expose typed admission seams, while third-party services enforce their own contracts. Trusted installed server code can still bypass an in-process convention, so this is not a sandbox for malicious plugins.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B12 [EXISTS], B14 [NEEDED].

#### U59 — Evaluation and regression workbench

**Experience.** A maintainer runs a collection of tasks against two prompt/model versions and compares outcomes, cost and latency. Results are reproducible enough to diagnose a regression without replaying publishing side effects against real services.

**Plugin.** An evaluation plugin owns case/version/result tables and creates isolated worker sessions with fake or sandboxed tool/environment contributions. Observation hooks collect comparable metrics; a page renders diffs and artifacts. Deterministic fixtures and side-effect interception belong to the evaluator, using public registries rather than a privileged hidden test mode.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B06 [NEEDED], B07 [NEEDED], B08 [NEEDED], B09 [NEEDED], B10 [NEEDED], B13 [EXISTS], B14 [NEEDED].

#### U60 — Headless SDK/CLI product

**Experience.** A script creates work, streams or polls progress and retrieves structured results without loading the web UI. It can reconnect after failure using the same request ID instead of starting the job twice.

**Plugin.** A CLI/client uses authenticated Chord contracts or a plugin-provided HTTP facade over session/input/control services. Long work is admitted durably and addressed by receipts; cancellation of a waiting HTTP request is distinct from explicitly aborting work. No page-only singleton, editor component or fake click is required to create or operate a session.

**Needs:** B02 [EXISTS], B03 [NEEDED], B04 [NEEDED], B05 [NEEDED], B07 [NEEDED], B08 [NEEDED], B12 [EXISTS].

## Merged base-piece inventory, ranked by coverage

This table is the deduplicated index. Counts include only the direct dependencies explicitly listed above, except B01, which is declared common to all cases. `NEEDED` entries often have existing library support; their missing part is the stable p3-facing contract and lifecycle/ownership guarantee. They are not fifteen arguments for enlarging the restart-bound base.

| Rank | Piece | Status | Cases | Use cases |
|---|---|---|---:|---|
| 1 | B01 Chord plugin/object substrate | EXISTS | 60 | U01–U60 |
| 1 | B02 Persistent state, routines and jobs | EXISTS | 60 | U01–U60 |
| 3 | B09 Replaceable UI shell/navigation | NEEDED | 48 | U03, U06–U31, U34, U36–U38, U41–U46, U48–U57, U59 |
| 4 | B04 Conversation control and durable input | NEEDED | 45 | U01–U12, U19, U21, U22, U25, U27–U30, U32–U37, U39–U46, U48, U50, U52–U60 |
| 5 | B03 Sessions service and catalog | NEEDED | 41 | U01–U09, U11, U12, U15–U19, U22, U23, U25–U27, U29, U32–U35, U40, U42, U43, U45, U47, U48, U51–U56, U58–U60 |
| 5 | B07 Observable harness and provenance facts | NEEDED | 41 | U01, U03–U08, U10, U11, U14–U16, U18, U19, U28–U37, U39–U43, U45, U46, U49–U53, U56–U60 |
| 7 | B05 Independent harness-part registries | NEEDED | 33 | U03, U06, U07, U09–U11, U20, U25, U27–U29, U31–U41, U44, U46, U49, U50, U53–U56, U58–U60 |
| 7 | B10 Typed targets, groupings and views | NEEDED | 33 | U03, U06, U08–U20, U24, U25, U27, U28, U30, U31, U34, U38, U43–U46, U51, U53, U55–U57, U59 |
| 9 | B12 Authenticated transports and caller identity | EXISTS | 31 | U01–U05, U13, U14, U18, U21–U27, U31, U32, U35, U38, U41–U44, U47–U49, U52–U54, U58, U60 |
| 10 | B06 Filters, hooks, wraps and operation gates | NEEDED | 30 | U03–U05, U11–U13, U16, U21–U23, U25, U27, U28, U30, U32, U36–U40, U44, U46, U49, U50, U52–U54, U57–U59 |
| 11 | B08 Worker/wake bridge | NEEDED | 21 | U01–U04, U06, U07, U11, U28, U29, U32–U35, U37, U40, U47, U53, U54, U56, U59, U60 |
| 11 | B13 Managed files and byte delivery | EXISTS | 21 | U01, U02, U09, U10, U12, U13, U19, U21, U24, U35, U40–U42, U44, U45, U47, U48, U52, U56, U57, U59 |
| 13 | B14 Execution environments | NEEDED | 19 | U09, U11–U13, U18, U28–U32, U38–U40, U44, U50, U56–U59 |
| 14 | B11 Questions/client-request bridge | NEEDED | 17 | U02, U08, U13, U15, U28, U30, U36–U38, U41–U44, U49, U53–U55 |
| 15 | B15 Process-owned platform bindings/data controls | NEEDED | 8 | U09, U24–U26, U43, U47, U48, U51 |

### B01 — Chord plugin/object substrate [EXISTS]

**Concrete pieces:** app-bound `defineFacet`, `local`/`remote` contracts with typed params and variants, `self.get`/`ctx.get`, addressable server/session hosts, watchables, `defineRegistry<C,V>` with `self.contribute`, native ownership, reload and failure states. A plugin's asynchronous standing behavior belongs in an object, not facet setup; UI contributions belong in a page/terminal facet so code and styles update together.

**Sources:** `packages/chord/docs/design.md` §§3–8, 16–17, 23; `packages/chord/src/host/facet.ts:13–55`; `apps/p3/docs/decisions.md:9–33`. Registry callbacks/natives are host-local and must not be smuggled through remote methods. Data crosses hosts as schema-checked arguments, state and typed addresses.

**Gap to avoid creating:** do not add a second plugin event bus, lifecycle manager or RPC system. Ordinary object methods, state and registry composition already supply these. The immutable API should re-export this vocabulary, not import every product's contracts into the base package.

### B02 — Persistent state, routines and jobs [EXISTS]

**Concrete pieces:** `defineState`, `self.state`, `self.tx`, keyed documents, tables with typed query/page APIs, bounded `self.query` live windows, `self.on`/`onLive`, and persisted `defineJob` runs with explicit rerun/abandon policy. Session-relative state that forks/rewinds with conversation history can use plugin-owned Durable documents; global inventory, grants, connector cursors and per-user preferences normally belong in Chord state.

**Sources:** `packages/chord/docs/design.md:973–1307,1468–1668`. Persisted Chord state belongs in host-lifetime local stores with empty params. Jobs keep objects alive; routines do not. A job's dedupe key covers unsettled work only, so lasting webhook/outbound dedupe must be application records, not an assumption about job keys.

**Important limit:** no cross-owner transaction and no arbitrary reads of another plugin's documents. A plugin exposes state/methods; dependents reconcile from current state. Chord jobs handle owned effects and finish commits; complex durable sleeps/waits/ownership inside a harness use Durable tasks. There is no need for an additional base workflow engine.

### B09 — Replaceable UI shell, navigation and commands [NEEDED]

**Existing foundation:** Chord serves reloadable page/TUI facets, React hooks, `usePageState`, terminal component scopes, translations and a sandboxed terminal launcher (`packages/chord/docs/design.md:2554–2643`). The old coding agent demonstrates user demand for replacing editor/header/footer, custom overlays, status/widgets, command/shortcut registration and renderers (`packages/coding-agent/src/core/extensions/types.ts:164–325,1638–1972`; `packages/coding-agent/docs/extensions.md:307–427`).

**P3 contract needed:** a single root surface slot plus a plugin-served `Layouts` registry; typed navigation state/methods such as `open(target, ctx, view?)` and back/forward/deep-link serialization; commands/keybindings and editable draft/composer state independent of one particular transcript component. Components may consume shared SDK widgets, but the SDK must not force a sidebar, a transcript center or a global project picker. Commands and UI buttons call service methods, not private component closures.

**Proposed contribution shape:** `LayoutRegistration { definition, Web?, Terminal?, configurationSchema }`; commands have a typed command definition, label, configurable default binding and a surface-local handler. Function-valued contributions stay on their page/terminal host. Web and TUI capabilities differ; a missing renderer is an explicit fallback, not an attempt to run React in a terminal.

**Policy limit:** Armin's permanently trustworthy top bar cannot be a security boundary against arbitrary same-origin plugin JavaScript. It can be a composition convention for trusted plugins; stronger trust requires an outside shell/origin or sandbox.

### B04 — Conversation control and durable input [NEEDED]

**Existing foundation:** Durable `Conversation` already has `submit`, `configure`, `reset`, `compact`, `fork`, `abort`, `waitForIdle`, `entries`, `context` and `watch`; `Submission` has durable status/wait/abort. See `packages/durable/src/harness/types.ts:63–132,821–891,899–969` and p2's peer broker contract in `apps/p2/plugins/conversations/contract.ts`.

**P3 exposure needed:** typed worker objects for those operations, plus a worker-local service used by tools/tasks. Submission must preserve request IDs, input/write/continue distinctions, steer/follow-up/reject behavior and receipt lookup after reconnect. An input envelope carries verified source attribution, content/attachments and selected targets; author display data never changes `Ctx.principal` or creates per-run authority.

**Critical behavior:** a browser, bot, orchestrator and CLI use the same admission path. Input may be transformed or handled by Input contributions before model context is appended, but the result is durably observable. A task waiting for a person is not represented by a long open HTTP call. Cancelling a wait and aborting work are separate actions. Reads/indexing must be available without accidentally resuming archived work.

### B03 — Sessions service and catalog [NEEDED]

**Existing foundation:** p2 exports `Sessions.create/rename/archive/restore/clone/fork`, an indexed catalog, lifecycle operation state and copy/seed contracts (`apps/p2/plugins/sessions/contract.ts`, read in full). This is a concrete starting point, not a reason to copy its owner/guest union or full historical API into p3.

**P3 service needed:** server `Sessions` with typed `create`, `configure`, `archive`, `restore`, `copy/seed` and list/detail views; durable receipts/state for multi-step creation/copy; origin/parent references supplied through plugin-owned records or explicit validated metadata. A creation request may name a stable request/session ID so racing channel messages or a retry do not create duplicate sessions. Setup must finish before first input can execute.

**Ownership:** server owns identity, archive and execution placement/admission; worker owns transcript and current content settings; per-user open/pin/read/recent state belongs in a separate preference plugin. A background session can be closed in every UI and still run. A worker reports only fields it owns; pending configuration survives a sleeping worker rather than opening its store from another process. Source: `apps/p2/docs/plugin-practices.md:7–84`.

**Not required in base:** templates, projects, triage subjects, channel IDs, business statuses, a universal Work record, or a mandatory resource source. Each is another plugin's data over the service.

### B07 — Observable harness and provenance facts [NEEDED]

**Existing foundation:** Durable conversation/task-graph watches and synchronous observers; document observers; commit publications; usage and task inspection. Sources: `packages/durable/src/harness/types.ts:788–819,893–969`; `packages/durable/src/types.ts:1100–1138,1214–1266`; Chord adapter model in `packages/chord/docs/design.md:2658–2713`.

**P3 exposure needed:** worker read/observe APIs for entries and the effective context, exported public document/view tokens, task/run graph, queue/idle/failure state, tool output/details, model attempts/usage, and wake state. Publish bounded server summaries for catalog dashboards, plus paged history and stable entry/task/submission IDs for replayable indexes. A plugin can own an index cursor without receiving every hidden plugin document or keeping all workers awake.

**Semantics that must remain visible:** a live view may fold changes, while commit observers concern stored commits; deferred progress can appear before persistence. A dashboard can use folded latest state; accounting/delivery/indexing must reconcile from durable records and a checkpoint rather than treating the watch as an infallible event log. Synchronous adapter observers only record; async work follows outside the commit.

`afterRun` is **not** a universal completion event: Durable calls it after answered/terminated successful work, not after abort/failure (`harness/types.ts:1011–1021`). Failure inboxes and statistics use task/run state and observations too. Context-component token counts and cost attribution may be estimates; expose measured data without inventing exactness.

### B05 — Independent harness-part registries [NEEDED]

**Existing foundation:** Durable's `Extension`, `RegistryReader`, `AgentState`, Tools/Sections and `HarnessOptions.models/env` exist (`packages/durable/src/harness/types.ts:337–571,702–786`). They are implementation material, not the p3 plugin surface requested in the brief.

**Needed registry identities and contribution roles:**

| Registry | Typed contribution role | Typical contributors |
|---|---|---|
| Tools | `readonly ToolDefinition[]`: schema, execute, structured output schema, details, replay policy, caller exposure | coding, MCP, triage, browser, code mode |
| Sections | `readonly SectionDefinition[]`: stable key and typed render context | skills, instructions, memory, environment facts |
| Models | model catalog/resolver plus request-capable adapter; secret resolution stays private | provider, gateway, virtual routing |
| Environments | typed environment definitions/resolvers producing an `ExecutionEnv` per selected target | local, SSH, VM/container |
| Input | ordered typed handlers returning continue-with-input, handled-with-receipt, or reject | chat modes, commands, connector normalization |
| Tasks | versioned Durable task definitions; names registered independently of current model-visible tool selection | automation, orchestration, approval, maintenance |

These are **proposed p3 types**, not existing exported names. Generic builders infer argument/result schemas; no `Record<string, unknown>` action bus is necessary. The adapter privately constructs Durable registrations and stores typed selection identities without leaking the `Extension` bundle abstraction.

**Key guarantees:** independent selection, dynamic contributions, collision reporting, task-definition availability on recovery, and a defined snapshot boundary per phase/request. A disabled tool's old task definition may still be needed to finish/abort recorded work. Do not equate tool availability, model visibility and nested-tool callability: Durable already distinguishes them.

### B10 — Typed targets, independent groupings and views [NEEDED]

**Requirement sources:** `apps/p3/docs/decisions.md:42–56`; `resource-model/book.md:625–659,1336–1389`; `layouts/mocks.html` concept captions. The old resource-specific row/panel pattern is a reusable illustration, not a requirement that every navigable thing is an owned credential-bearing resource.

**Minimal typed vocabulary, proposed:** a plugin exports a target-kind definition backed by its contract/params and a typed constructor for target references. On the wire the discriminant and params are data; callers construct them through the definition, not arbitrary strings. A view registration is parameterized by that definition, form (`row`, `card`, `detail` or another declared form), and surface. A detail may assemble independent panel registrations for that target type.

`GroupKinds` contributions supply a typed grouping identity, source of target rows and header/extras renderer. `Views`/`Panels` and `Layouts` compose presentation. A target may appear in any number of groupings; grouping membership is not an authority edge. An optional permissions plugin can attach policy to those same typed identities without making its lists mandatory for every grouping.

**Base need versus ordinary plugin:** the root renderer/navigation must accept arbitrary typed targets and alternative layouts. The registry owners, default session view, project grouping and canvas renderer are all reloadable plugins. No universal graph database, universal object class or central enumeration of every plugin's domain objects is needed.

### B12 — Authenticated transports and caller identity [EXISTS]

**Concrete pieces:** kit `Http` routes/wraps/sockets, `Authenticators`, link admission, stamped principals, per-principal remote variants, typed route authorization and Chord revocation. Sources: `packages/chord/docs/design.md:491–648,2337–2428,2487–2514`. HTTP contributions can define public/cross-site inbound routes; a webhook plugin validates its own signature because browser session identity is not webhook authentication.

**Semantics:** links stamp principals, not input data. A `ctx.get` down to a worker preserves its caller; an upward worker call is authenticated as the worker and needs explicit checked actor/source data for delegated operations. A local object's handler acts as the host, not the remote user's principal. Source: design §§4–5 and §8. Verify/stamp at ingress and preserve the intended actor at each service boundary; do not infer authority from a displayed name or from the sender block in a prompt.

**P3 wiring still needed within B15/B06:** make authentication and revocation usable by plugins without exposing owner tokens to page code; add typed admission on base-owned operations. Sharing/OAuth providers, account linking, ACLs and Radius policy remain plugins. Existing kit protection does not mean Cristina's Radius guest flow is already implemented.

### B06 — Filters, chains, wraps and operation gates [NEEDED]

**Existing foundation:** Durable `beforeTool`, `afterTool`, `beforeRequest`, `beforeProviderRequest`, `afterResponse`, `onYield`, `afterTools`, `afterRun`, `beforeCompact`, and tool/section wrappers (`packages/durable/src/harness/types.ts:409–427,971–1097`). These hooks do not all block or transform: the typed result of each stage matters. Environment/model wrappers can be composed around the adapters supplied to the harness.

**Needed p3 shape:** per-part selection filters, ordered hook chains and whole-operation wrappers. Illustrative in-process signatures: `filter(selection, scope, ctx) -> selection`; `beforeTool(call, ctx) -> continue | replaceArguments | block`; `wrapTool(tool, scope) -> tool`; `wrapEnvironment(env, scope) -> ExecutionEnv`; input chain `handle(input, ctx) -> continue(input) | handled(receipt) | reject(reason)`. These are schematic roles, not a single boolean-switch handler or an invitation to expose raw Durable extension bundles.

**Composition contract:** define phases/order, deterministic conflict reporting, whether arguments are revalidated after transformation, deny precedence, behavior on throwing/missing policy contributions, snapshot lifetimes and cancellation. Chord's contributor-name ordering is deterministic but deliberately not a policy priority scheme. A security gate cannot use “catch and continue” as its allow fallback; failure must leave the controlled operation blocked while still reporting the contributor.

**Direct service operations:** session creation/configuration/archive, input, copying and platform control need typed admission seams too. A Sessions owner can serve `SessionAdmissions` with typed before-create/configure/copy hooks; an environment owner enforces file/terminal methods. There is no need for a universal string `authorize(action, payload)` bus. Hooks before model tools alone cannot restrict a direct page call or a server automation. Installed server plugins are trusted code; no in-process interceptor can constrain one that deliberately bypasses the APIs.

**No per-run authority:** origin/actor facts explain attribution and approvals; session configuration limits what work can reach. Recheck current restrictions at actual dispatch, including nested calls and work delayed behind an approval. A filter only changes what is offered; it is not proof that an old queued call or direct service method is safe.

### B08 — Worker/wake bridge [NEEDED]

**Existing foundation:** Chord address routing starts a worker when its object is held; kit workers expose state, stop/retry and idle behavior. Durable exposes `Wake { active: boolean; at?: number }`, `Harness.wake`, `onWake` and `resume` (`harness/types.ts:746–787,901–915`; Chord design §§3,23; `packages/chord/src/node/app/worker.ts:26–35,44–117`).

**P3 bridge needed:** publish wake as observable worker state, report activity to the kit's busy input, and keep a server-owned durable wake index so a sleeping worker can terminate without losing the timer that must restart it. A due wake holds/gets the worker's object and invokes the resume path only after plugins load. The index needs acknowledgement/reconciliation for crash windows, not merely a timer in the worker that is about to die.

**Policy stays out:** no mandatory cron, queue priorities or automatic infinite restart loop. Kit workers intentionally do not restart arbitrary failures by themselves; a scheduler/supervisor plugin can offer explicit retry/backoff with a visible failed state. A closed tab, no open cards, an idle conversation and a worker with future scheduled work are four different conditions. Long-lived polling routines are not keep-alive counts by themselves.

### B13 — Managed files and byte delivery [EXISTS]

**Concrete pieces:** kit `Files`/`FilesFolder`, spaces and indexed immutable blobs, revisions, metadata, chunked upload/read, copy; HTTP byte/file responses and authenticated sockets. Sources: `packages/chord/docs/design.md:2347–2424,2511–2520,2644–2656`; kit exports in `packages/chord/src/node/app/index.ts`.

**Use:** reports, patches, screenshots, voice notes, imported datasets and conversation attachments refer to files with provenance. Large bytes travel through chunked methods or HTTP/socket channels, not unbounded state members. Chord explicitly defers a reusable acknowledged byte-channel abstraction until another concrete user justifies it; plugin sockets suffice now.

**Important separation:** managed artifact storage is not arbitrary access to an execution environment's filesystem. Downloads and executable HTML need appropriate attachment/CSP/sandbox handling, and routes must apply the same sharing policy as the object views. Historical replay requires retaining versions/captures deliberately; a path in the current checkout is not a historical artifact.

### B14 — Execution environments [NEEDED]

**Existing foundation:** `ExecutionEnv extends FileSystem, Shell` in `packages/durable/src/env/index.ts:212–377`, with typed filesystem operations, canonical paths, watches, context-bound `exec`, output handling and cleanup. `HarnessOptions.env(target, context)` resolves it at each use (`harness/types.ts:694–734`). p2's workspace contract demonstrates live file/diff/status and transfer APIs over a conversation location.

**P3 contract needed:** Environments contributions in B05 plus typed environment identity/status/selection and a public resolver usable by worker tools and related plugins. A session's placement configuration is not an untyped global `process.cwd`; model and tool APIs receive the environment actually selected for the work. Wrappers must apply to the whole adapter, including file reads and nested operations, not only a tool named `bash`.

**Plugin-owned:** local/SSH/VM implementations, PTYs, browser profiles, worktrees, network policy, narrowed folder views and reconnect strategies. Do not force a VM to expose a filesystem API it does not implement; represent unavailable capabilities. Security confinement has to exist beneath unrestricted shell execution, not just in a path field or UI chip.

### B11 — Questions and client-request bridge [NEEDED as reusable plugin, not kernel]

**Existing primitives/pattern:** owner-kept flow state with typed answer/cancel methods, and the Questions design in `packages/chord/docs/design.md:1849–1892`. That section describes a pattern/proposal, not evidence of a finished p3 Questions service. Clients are not addressable Chord providers (§3); a tool cannot simply `ctx.get` a camera object hosted by an arbitrary browser.

**Proposed reusable contract:** `Questions.ask(question, key, ctx) -> questionId`, an observable per-audience open-question view, `answer({question, revision, answer}, ctx)`, `cancel`, and a durable task wait/resume integration. Questions carry schema-typed content, target/work reference, deadline and audience; stale/duplicate answers are rejected atomically by the owner. UI-local dialogs remain local when no durable work depends on them.

**Client capabilities:** the same owner-request/client-answer pattern can ask an eligible client for a file, photograph or selected page data, with explicit user consent and a disconnected/unavailable result. It need not pretend a transient client is a server host. Quorum rules, approval text, notifications, fallback into chat and policy are optional behavior built on that contract.

### B15 — Process-owned platform bindings and portable data controls [NEEDED]

**Existing components but not sufficient plugin access:** `App` exposes `host`, `workers`, plugin state/install, `applyChanges`, `exportData` and `importData` (`packages/chord/src/node/app/app.ts:216–275`). `startWorker` owns the host/store and accepts `busy` at bootstrap (`worker.ts:26–35,44–117`). A plugin facet receives only serve/references and contribute APIs (`packages/chord/src/host/facet.ts:13–55`). `AppInfo`/`WorkerInfo` expose start data, not those native capabilities (`node/app/info.ts`).

**Minimal bridging:** bootstrap installs a host-lifetime provider of narrowly typed native bindings through an in-process registry: access to the host's existing store for the harness adapter, a scoped `root(fn, context)` bridge for Durable callbacks, worker busy contributions, and authorized app-management/archive controls. The provider closes nothing it does not own; its consumers do not open a second writer or put callbacks/native handles into remote object values. Management methods exposed over Chord validate caller authority separately.

**Concrete backup gap:** current `App.exportData/importData` call `#workersOf(address)` and operate on worker directories (`app.ts:751–820`). They do **not** provide a whole-instance/server-store archive. Radius instance backup needs server and worker enumeration, safe server export/outbox access, file/plugin manifests, and restore coordination; worker archive support alone is insufficient. Continuous sync also requires enabling/consuming the store outbox, distinct from archive export.

**Do not expose:** owner token strings, raw private configuration, unrestricted store scanning to clients, or an untyped “get runtime” escape hatch. Trusted server plugins can own credentials through their own services, but viewer methods and backup policies must not accidentally publish them.

## Minimal set: what to keep, merge or cut

### The actual restart-bound base

Keep only **bootstrap and shared vocabulary**: the API package/re-exports, principal type, server and session host kinds, startServer/startWorker entry points, one root slot per client surface, and the small bridge for capabilities already owned by those processes (B15). This follows `apps/p3/docs/decisions.md` rather than older Chord examples that happen to place the harness/catalog/access logic in a core facet.

The kit/Chord runtime necessarily owns link authentication mechanics, object lifetime, schema checks, store commit ordering, reload, worker process management and HTTP baseline protections. A plugin may choose policy and providers, but cannot be responsible for making its own caller identity unforgeable or its own transaction atomic. These are the genuinely non-plugin mechanisms; they are mostly already implemented below p3.

### A small standard plugin set, not a large base

1. **Sessions:** B03, with its own typed admissions and metadata views. Keep application-specific groupings, UI open state and templates out.
2. **Harness:** merge B04, B05, B06, B07 and the worker side of B08 into one public family of contracts/registries, implemented with small lifecycle owners. Separate conceptual APIs do not require separate global services or mandatory public Durable extension bundles. The six part registries remain separate as requested.
3. **Wake/supervision adapter:** the server side of B08 owns persisted wake bookkeeping and uses kit workers. An automations plugin owns schedules, triggering, catch-up and retry policy. The platform bridge must make this possible without editing worker bootstrap each time.
4. **Surfaces/composition:** merge B09/B10 as the minimal UI contract family. Root-layout selection, typed target navigation, independently contributed groups, views and panels are enough; Home, transcript, dashboard, board and canvas are alternative plugins using them.
5. **Environment integration:** B14 is the Environments part's reusable contract plus separately installed adapters, not a competing resource registry. Files/terminal/browser plugins may add typed views to its targets.
6. **Questions:** B11 is a reusable optional plugin implemented from B02 plus B04/B05, not a new kernel lifetime or an obligatory central approval engine. A bespoke application can own its own question state if interoperation is unnecessary.

B01/B02/B12/B13 should be re-exported or adapted, not rebuilt. B15 exposes process-owned capabilities once. This is the minimum **enablement** set; a useful default distribution will install more plugins, but their absence must not invalidate unrelated products.

### Things to cut from the mandatory model

- A core Project, Resource, Grant, Loan, Home, Inbox, Board, Ticket, AgentTeam or universal Work type. Plugins can publish their own typed domain records over stable session/input/observation contracts.
- One obligatory grouping tree, one owner of every navigation item, or one resource-list source for every product. A resource-policy plugin may impose the old list model where wanted; display-only grouping must still work without it.
- A second generic authorization engine alongside Chord. Keep authenticated identities, enforceable variants and typed admission seams; policies/ACLs/company roles are plugins. Do not claim that hooks sandbox installed server code.
- A generic event bus as the source of truth. Use observable state plus durable records/cursors; ephemeral events may be an optimization, not the only evidence that work needs doing.
- A second workflow runtime for automations. Use Chord routines/jobs for reconciliation/owned effects and Durable tasks for conversation-owned multi-step work.
- Separate chat-app, UI-button, CLI and agent-only implementations of create/submit/approve/publish. Adapters call the same typed services and retain their own external receipts.
- A generic streaming type or massive UI schema to support speculative products. HTTP sockets/chunked files and ordinary surface-local components already permit terminals, voice and video adapters. Add a shared abstraction only after repeated implementations establish its actual semantics.
- Always-on capture of every prompt, terminal byte and browser image. Observation enables replay/audit plugins; persistence, sensitivity and retention are product choices.

### What cannot be made “just a plugin” by naming it one

**Trust boundaries.** A malicious server plugin has the process's authority; a model/tool filter cannot contain it. A restricted shell needs real OS/VM/remote-service confinement. Arbitrary viewer-side JavaScript cannot become trusted merely because its components use typed contracts.

**External platforms.** iMessage access needs an appropriate device bridge; native mobile capture/lock-screen surfaces need platform integration; Radius account admission, guest grants and vetted bundle serving need Radius changes or existing extensible APIs there. A p3 plugin can be the integration half, not replace those systems.

**Bootstrap-owned objects.** The actual Host, Store, HTTP listener, worker supervisor and running plugin loader exist before feature plugins and cannot be fabricated independently by each one. A small binding provider makes them usable; rebuilding them inside a plugin would create duplicate owners and writers.

**Deployment and restore exclusivity.** A process cannot restore over its own live store as an ordinary mutable document operation. Provisioning, locks and an import/start boundary are required; the user-facing workflow may still be a plugin or external Radius app.

## Product-level acceptance tests for the seams

These are proposed tests, not tests run in this analysis.

1. **No-browser assistant:** install only a connector, session/harness services and its tools; receive two duplicate webhook events while the worker is asleep. Exactly one admitted input appears, a reply is delivered through a recoverable receipt, and no page plugin is needed.
2. **Closed Discord creation:** concurrent first messages select one template-created session; configuration is effective before the first model request. It remains absent from the owner's open tabs until opened, yet produces its answer and appears in the channel grouping.
3. **Home plus triage:** install both independently. Home can start work from a triage issue's typed target, the triage queue can open a new session from its analysis, and neither needs a core issue/project special case.
4. **Independent UI replacement:** install a second layout, a machine view and a third-party Usage panel for that machine. Replace the default transcript-centric shell without changing the server/session APIs; unregister a view and show a useful fallback without losing the target's data.
5. **Delayed denial:** park a tool behind an approval, withdraw its permission, and then answer the old prompt. Recheck dispatch and reject it; verify the nested-code-mode and direct-server-method paths too. No transient filter failure falls back to all tools.
6. **Cold wake:** persist a future task, allow its worker to exit, restart the server, and reach the deadline with no client connected. Work resumes or has a visible explicit failed/retry state; it is not lost because a worker-local timer vanished.
7. **Slow dashboard and audit:** fold many live progress changes for a slow viewer, but let the audit/statistics plugin recover complete durable outcomes from its checkpoint. Opening the dashboard does not start every idle worker.
8. **Share boundary:** reader cannot submit, reconfigure, fetch a secret or use an unguarded attachment route. Revocation affects live references and subsequent requests; a viewer never silently receives owner-only unvetted UI code.
9. **Real sandbox handoff:** continue a triage result in a new environment; retain the chosen patch/history but not the old VM's claimed existence, credentials or connector bindings. Apply/publication of a stale patch requires an explicit current check.
10. **Restore the instance, not just sessions:** back up server configuration/plugin state plus workers and managed files, restore into a clean deployment, then verify schedules, mappings and per-user views before enabling external side effects. Missing plugins/accounts become visible repair steps.

## Open questions

1. **Policy direction:** does the instance-trust proposal keep optional genuinely read-only/session-restricted sharing, or is every viewer intentionally a fully trusted instance collaborator? Both are implementable products, but their defaults and security claims differ. The notes explicitly leave this unresolved.
2. **Viewer code:** is Cristina's Radius-built viewer bundle required, optional, or superseded for custom instances? How are third-party viewer components vetted/distributed, and what happens when only the owner can run the custom UI?
3. **Harness API stability:** which Durable value types may p3 re-export directly, and which become p3-owned contracts? The firm rule is no public Durable `Extension`; it does not require gratuitously reimplementing every tool/result schema.
4. **Policy composition:** one selected policy provider, or multiple narrowing contributions? Decide deterministic phases, deny/failure behavior and what reconfiguration can affect already-admitted work. Registry contribution order alone is not enough.
5. **Typed target ownership:** do view/grouping tokens live in a common composition plugin contract, with target definitions in owning plugins? This is my recommendation; the source requires typed addressable things but does not settle every wire/reference detail.
6. **Session versus conversation:** when does an orchestrator create a child conversation in one worker versus a separate session/worker? Expose both; choose based on environment/isolation/lifetime needs, not because Home cards are always forced to be one or the other.
7. **Wake recovery:** what persists the server wake index and what reconciles a crash between worker commit and wake report? Who may automatically retry failed workers, and how does archive suppress or cancel schedules?
8. **Question scope:** which shared question kinds/interoperability are worth standardizing first? Durable task resumption and revisioned answers are necessary; universal quorum/approval policies can wait for a real product needing them.
9. **Configuration while asleep:** which configuration fields are server-owned inputs and which worker-owned content? Preserve one writer and pending-edit reconciliation; do not solve this with alternate running/stopped write paths.
10. **Portable state boundary:** does Radius back up credentials, just credential references, or selectable encrypted secrets? How are server stores, plugin package versions, external files, VM state and encryption recovery keys represented, and what is explicitly not restorable?
11. **Restricted environments:** will “lend a folder read-only” be a supported enforceable product or merely a proposed UI? The answer determines which constrained environment adapters are required; a tool filter cannot retrofit that promise onto an unrestricted shell.
12. **Guaranteed observations:** which facts must the harness expose durably for accounting, replay and delivery reconciliation? Define raw measured usage versus estimates, stable IDs, failure/abort coverage and retention rather than promising a lossless stream of all live UI updates.
13. **Integration admission:** does each connector map external identities entirely inside its plugin, or is a standard identity association plugin desirable? In either case authenticated source facts and user labels must remain distinct.
14. **Minimal bootstrap bridge:** can the kit expose store/root/busy/app controls as narrow native registry contributions once, plus typed guarded remote controls where needed? Current App methods being available to the start script does not make them usable by third-party facets.

## Reading and verification scope

Read the brief, direction notes, Armin and Cristina texts in full; the full Durable harness types; Chord design §§3–11,14–18,20,23–24 as cited; p3 decisions; the coding walkthrough body; all layout concept captions and selected mock content; the relevant resource-model grouping/view sections; p2 plugin practices and the sessions/workspace/conversations contracts. The old coding-agent extension types and documentation were inspected as an API/lifecycle catalogue (UI, registration, inputs, hooks, providers), not audited end-to-end. Triagent's full README and complete `src/agent-runs.ts`, `src/pi-session.ts`, and `src/fix-pr.ts` were inspected at the pinned commit. The dsh-context README introduction/dashboard sections were read as product evidence, not its implementation.

No repository files were edited, no tests were run, and no commits were made. All proposed p3 API names above are sketches, explicitly separated from existing library APIs.
