# p3 decisions

The owner's decisions for p3, newest last. Chord decisions are in `packages/chord/docs/decisions.md`; the working
rules are in `workflow.md`. An entry marked **(Superseded …)** is kept as the record; the entry it names wins. Paths in
older entries that say `docs/<file>` or `apps/p3/docs/<file>` now are `apps/p3/docs/archive/<file>` (moved 2026-11-14).

- **(Superseded by "p3 lives on main", 2026-11-07.)** **Work on branch `p3` in `/home/badlogic/pi`, no worktrees (owner, 2026-11-06: "no worktree. work in a branch in the
  pi folder"):** the shared checkout is switched to `p3`; p3 work, and Chord changes p3 needs, are committed there and
  pushed to `origin/p3`; Chord changes are brought to main afterwards. Build subagents work in the same checkout.
- **p3 lives on main (owner, 2026-11-07: "switch to main, p3 can live there too, branch sucks"; supersedes "Work on
  branch p3"):** `apps/p3/` on main of earendil-works/pi; commit only your own files, never `git add -A`.
- **Reloads first (owner, 2026-11-06: "first order is actually the whole reload shit. that needs to be smooth and
  perfect ... keep [server restarts] to its absolute minimum"):** base code is vocabulary (the API re-exports Chord's
  plugin surface once; the principal, `defineFacet`, host kinds; the start script, the worker entry, a web entry
  rendering one slot); every behaviour, the page's shell included, is a plugin. Registry tokens, contracts and helpers
  live in the contract file of the plugin that serves them. An object owning a native sits in a small plugin of its
  own; the logic around it in other plugins, read at use. A step is done only when editing each of its plugins during
  use loses nothing and leaves the kit's restart mark (`plugins.state.base`) false.
- **(The step order is superseded by `slices/`, 2026-11-14; baby steps stand.)** **Baby steps (owner, 2026-11-06: "we want baby steps, not humongous steps, we should start with something
  simple"):** step 0 is the kit server (own port and data directory), the owner's sign-in and one page plugin showing a
  value from a server object, done when editing it on the page and on the server reloads it in place without a
  restart (the reload test every later step keeps green). Then one small step each: a session list, a session worker,
  the harness with a fake model and a minimal chat, real models, and on. The first spec draft (the whole skeleton at once)
  moved to `docs/map/`: a map of where the steps lead, not a spec.
- **(Superseded by "The principal is identity only", 2026-11-13.)** **Principals are `server`, `worker`, `user`, `guest` (owner, 2026-11-06):** `{ kind: "server" }`, `{ kind: "worker";
  session }`, `{ kind: "user"; id }`, `{ kind: "guest" }` reserved until sharing is designed. The owner is the first
  user: the kit's owner link signs in as the user p3 names (Chord decision "The kit's owner is a principal the app
  chooses").
- **Keep the app kit, change it where it does not fit (owner, 2026-11-06: "ok"):** p3 starts with `startServer` and
  `startWorker`; gaps found (the owner principal; later a plugin's access to its host's store and root scope,
  keep-alive counts from plugins, an "apply changes" object) are fixed in the kit, each a Chord decision.
- **UI is contributed from a plugin's facet (owner, 2026-11-06: "A"):** a page or terminal plugin contributes its
  components from its facet's setup; objects in a page supply data (held with `useHold`), never the UI itself. Reason:
  a facet's contribution is swapped in one update on a reload, always styled; an object's UI stays old until its
  successor is live and can show unstyled meanwhile (Chord decision "A restarting page object's old UI may show
  unstyled").
- **Code is committed only after the owner reviewed it; docs, specs and decisions without (owner, 2026-11-06).**
- **Base entries are named after what they are (owner, 2026-11-06: "i want things to be named after what they are"):**
  `server.ts` (the server: `startServer`), `worker.ts` (a session worker: `startWorker`), `supervisor.ts` (runs the
  server as a child and starts a fresh one on request or after a crash, so "restart needed" can be acted on from the
  page); the `p3` command runs the supervisor. To be specified in step 0b.
- **Startup building is measured with telemetry (owner, 2026-11-06):** spans for a server start (store, each base
  build, plugin discovery, each plugin build, the load), each worker start and each Apply, in the kit's telemetry
  store; to be specified as a small Chord change.
- **Requirement for the skeleton: groupings and views are plugins (owner, 2026-11-07, relayed by session cbe4592b from
  the owner's discussion with Christian, Max and David):** plugins contribute kinds of groupings (sessions per
  env/cwd, projects, Discord servers, recent, ...), each grouping any addressable thing (sessions, envs, MCP servers,
  project files) and rendering its own header and extras, without stepping on other plugins' groupings. Selecting an
  addressable thing shows a view of it that plugins define: the main area is not always a transcript (an env: a file
  browser, terminals, later VNC). Transcripts stay central; layouts must allow less transcript (an agent may compose a
  view). The container (a sidebar or not) is open. Skeleton consequence: the page's route is a `(kind, id)` of an
  addressable thing, the main area renders the view registered for that kind, group kinds and views are registries (web
  and terminal). Access policies are out of scope for now but must fit later (session resources). Sketch: session
  cbe4592b's artifact `p2-sidebar-groups`.
  Addendum (owner, 2026-11-07, relayed by cbe4592b): go radical. The layout itself is plugin-defined (sidebar +
  transcript + panel is one layout among others, shipped as the default "so as not to rattle cages"); the data model of
  addressable things, groupings and views is the point and must allow free composition, also where the terminal cannot
  show all of it; access control (which resources a project or session may use, who may see or do what) must attach to
  the same model later, not be designed separately.
- **No per-run authority; what is brought into a session is the control (owner, 2026-11-08: "there is no point in trying
  to prevent prompt injections. that's why one should be able to define what is brought into a session"):** everyone
  who may send in a session uses every resource in its selection, whoever started the run (as decided earlier: `origin`
  is out, illusory against prompt injection). The stress test's "authority per run" gap (`model-stress/report.md`, both
  reviews) is dropped; defining a session's resources (projects, lock-down, what is brought in) is the mechanism.
- **(Superseded by "Locks" and "Direction", 2026-11-13: one owner, only people confined, locks instead of resources and a policy plugin.)** **Resource model direction (owner, 2026-11-08, voice walkthrough; to be specified and reviewed against p2's
  features, then explained):** users (including a reserved instance user for company resources); resources, each owned
  by one user, with its own login or none, never changing whose login it uses (Cristina's own Radius login is her own
  resource); users create resources only for themselves, admins for the instance user; plugins create their built-in
  resources (tools, prompt sections: one Durable extension = one resource) for the instance user when installed.
  Groupings are plugin-defined and only show things (any number per session, computed like folders/recent or curated
  like projects); a grouping "with resources" keeps its own resource list in its own plugin and tells core how to read
  it; a session has exactly one resource source: its own list, its owner's defaults (the rule "everything I own plus
  every instance resource I may use", so new tools appear by themselves) or one grouping with resources (one field on
  the session: the invariant is structural). Everyone who may send in a session uses its whole list (no per-run
  authority). One replaceable policy plugin (a registry with one provider; built-in default: the single user may do
  everything) guards create, bring, add-member and similar typed operations through one guarded step in core; plugins
  never know about ACL, SAML or Radius; the UI only renders server views (e.g. a per-user list of creatable kinds
  computed with the policy). Workers follow their session's list live; the harness lets in only extensions whose
  resource is on it (and belongs to the contributing plugin); resource plugins' per-session server views check the list.
  Configured resources cover fine-grained cases (conversation access to one session with chosen actions, expiring list
  entries). Rendering: renderers per contract and form (row, card, detail, ...) from any plugin, detail views assembled
  from panels several plugins contribute. No stringly-typed APIs.
- **(Superseded by "Session data on the server as host-keyed documents", 2026-11-09.)** **Session metadata store on the server (owner, 2026-11-09, voice):** a session's data lives in one of two places, and
  a plugin picks one per fact. (1) The **session metadata store** on the server, provided by the base: everything about
  a session that is needed while its worker is not running (title, pin, archive, location, a Discord channel binding, a
  plugin's labels or settings for that session). Any plugin writes to it under its own typed key per session (a token
  defined once in its contract file with a name and a schema, like `defineState`); server code reads and writes it by
  session id without starting the worker; the worker reads its own session's metadata through a view and writes through
  server methods (one writer: the server). A rename is one server write. (2) The **session's own store**: everything
  only used while the worker runs (transcript, Durable state, a plugin's working data). Never keep the same fact in
  both. Export of one session = its store plus its entries in the metadata store; import writes both back and resolves
  references to instance things (environment, providers). Sessions stay self-contained as a unit; no tagging of
  arbitrary tables, no pending edits. Replaces the split proposed on PR #11951 (comment 6737930304).
- **Backups, not session sync; one format (owner, 2026-11-09, voice):** no per-session sync and no synced read-only
  copies elsewhere (a session without its instance, its environments, providers and plugins, is useless; the use case
  is working with a session, never reading it remotely). Radius offers whole-instance backups (the server store and all
  session stores together) and restore onto a new machine. The **sync format** of Chord's stores stays the one format
  for both backups and exports (a single session's export: its store plus its session metadata entries): it encodes
  every kind of data the core stores hold, plugin data included, and we bet on it.
- **Session data on the server as host-keyed documents (owner, 2026-11-09, supersedes the typed metadata store of the
  "Session metadata store" entry):** each plugin keeps its per-session server data in its own server object as Chord
  documents or table rows keyed by the session's host address (`defineState(..., { keyed: Session })`, table columns
  `host(Session)`; Chord decision "Documents and table rows can belong to a host"); its worker part follows its own
  document through its own view (pinned with `at(Session({ id: principal.session }))`). Export of a session = its own
  store + every server record and row belonging to its address, in the store archive format; import into a non-empty
  store refuses, replaces explicitly, or copies under a new id; delete retires them. The rule stays: anything needed
  while the worker is off lives on the server, the rest in the session's store, never both. No central metadata store,
  no `metadataOf`, no export callbacks.
- **Efficiency is a requirement (owner, 2026-11-09):** p3 must be extremely efficient: dozens to hundreds of session
  workers on one reasonably beefy machine, and a super snappy UI. Every design and build step states its memory per
  worker, its startup cost and its bytes on the wire for common UI actions (switching sessions and conversations),
  and measures them; findings of p2's perf work (session "fucked up perf", subagent `worker-mem`) feed p3's design.
  Any Chord change made for performance (for example references sharing or keeping replicas) must keep Chord's
  correctness guarantees and goes through the full review.
- **Tests are isolated and deterministic (owner, 2026-11-09, after p2's subagents test race):** each test case gets its
  own session (and its own subagents, conversations and stores); nothing a case leaves behind is visible to the next.
  The fake model answers what the test scripted for each request, deterministically, never "whatever came last"; a
  request it has no script for fails the test. A test waits for an effect it caused (an entry newer than its own input,
  a result of its own call), never for a pattern that may already be there. A failure under load is a bug until its
  root cause is known.
- **(Superseded by "The agent writes plugins" and "Artifacts and views".)** **A view's frame is a Chord client with a view principal and its own socket (owner, 2026-11-10):** agent-made views
  run in sandboxed frames that connect to the server with their own link, authenticated by a short-lived token scoped to
  the view, as a principal `{ kind: "view", session, view, for }` that never gets the viewer's powers; objects serve view
  variants (the room for real-time collaboration among them). One WebSocket per view, not piggybacked on the page's:
  a fast view never queues behind the page's traffic; piggybacking (a weaker principal for a relay's origin) waits for
  a case. Details: `views.md` §4a.
- **Read-only sharing (owner, 2026-11-11: "we obv want read-only sharing"; merged.md §4 question 2):** a session can be
  shared with a viewer who reads everything and sends nothing (`mayView` without `maySend`), besides full participation.
- **The agent writes plugins; sketches stay single-player (owner, 2026-11-11: "radical idea: this is all fucking
  stupid. what if the agent had a tool to write/edit the contents of plugins directly"):** anything an agent builds that
  is multiplayer, persistent or needs rules (games, shared boards, Max's glyph editor) is a plugin the agent writes and
  applies itself, with a server object, typed contracts and Chord state and events, whatever environment the agent
  otherwise works in. The trust boundary is access to the server; prompt injection through ingested content is an
  accepted risk (it already applies when the agent works on the server machine), and a guest who may send can already
  have the agent run `bash` there. The plugin tools are ordinary tools in the session's selection: a locked-down
  session does not get them, as it does not get `bash`; no extra apply gate. Sandboxed HTML views remain only as
  single-player artifacts. Dropped: the generic room (p2 rooms v1 stays as a playground), the rooms v2 leader design
  and the rooms v3 sequenced model (`apps/p2/docs/rooms-v3/`, kept as the record of the use cases), view principals for
  sketches, and views.md's two-tier decision for agent-made views. First built in p2.
- **Artifacts and views (owner, 2026-11-12; p2 builds it first, p3 takes the same structure with rough edges sanded
  down):** each plugin owns its per-session data, keyed by the session's host address on the server (export, import and
  delete carry it; versions are the plugin's business). A web registry `ArtifactKinds` (title, icon, live
  `useItems`/`useCount`, optional `Row` and removal, the view kind that opens an item) collects listable items for the
  artifacts sheet and button; `ViewKinds` only gives panes (`PaneProps` `item`, `inline`). Inline artifacts are a tool
  card rendering the item's pane, mounted only while visible. Plugin tools are code-mode only, grouped by the code-mode
  namespace their extension declares (description in the prompt, instructions on demand); the prompt lists namespaces
  from configuration so it stays stable when servers connect. Supersedes "A view's frame is a Chord client with a view
  principal" and drops rooms and the view library. As built in p2: html artifacts keep the custom views' page API
  (`window.p2view`, state per artifact); a reader who may not change the session's views opens an item in the
  artifacts side panel on their own device; a session's clone and fork copy its artifacts.
- **(Superseded by "Locks" and "Direction", 2026-11-13.)** **Instance resources, not an instance user (owner, 2026-11-13: "an instance user seems stupid. instance resources
  make more sense"; refines "Resource model direction"):** a resource's owner is `{ kind: "user", user }` or
  `{ kind: "instance" }`. Resources plugins create when installed (tools, prompt sections) and company resources (a
  shared login, a team server) are instance resources; the policy plugin decides who may create or bring them (default:
  the single user may do everything). No pretend user appears in lists, presence or audit.
- **(Withdrawn later on 2026-11-13: "settings are garbage"; replaced by "Apps are plugins; users and guests are the confined people" below; org-managed Pis to be redone on apps.)** **Org-managed Pis through managed settings (owner, 2026-11-13: "I'm in favor of the Opus model ... it just needs to
  be flexible"; supersedes the policy plugin of "Resource model direction" and the company resources of "Instance
  resources"):** one Pi per person; everything an org wants is a setting. Plugins declare their configuration with
  `defineSetting` (a name, a schema, an initial value, merge `value` or `entries`) in their contract file; the base keeps
  the member's values and every write goes through `Settings.set` (the page, the agent's tools, other plugins). The
  org's values form one managed layer that gives any setting a value with lock `default` (a starting point; org
  entries sit beside the member's, read-only) or `locked` (only the org's value counts; the member's values are kept
  and ignored); `set` refuses a locked setting or an org entry with the error code `managed` ("Managed by Acme").
  Provisioning and deny lists are the same data; there are no operations, levels, rule tables or policy functions.
  A machine is enrolled by a root-owned file at a fixed path (`/etc/p3/enrollment.json`: org, server, org key,
  allowed plugin sources; no secrets); an enrolled Pi stays locked (gate `pending`: no sessions, only the app root
  loads, settings at their initial values) until its first sync with the org server (Radius) delivered a profile
  signed with the org key and bound to the member and the Pi, the required plugins installed at pinned refs and
  hashes, and the profile was written as the cache; later starts open from the cache and follow updates live
  (settings first, plugin additions once installed). Gate states `unmanaged`, `pending`, `ready`, `stale` (optional
  `maxOffline`), `revoked`. "No agent-written plugins" means only approved builds load (`p3.plugins.own`). In-process
  checks are guardrails against the member's agent and well-behaved plugins; sharing, peers and org models are
  enforced at Radius from the same profile. Kit change: `startServer` takes plugin roots and an `admit` function.
  Needed in the base now, before any org: the settings mechanism as the only configuration (no plugin JSON files),
  the `managed` error, installs and Apply only through the base, the sharing and peer audience settings, and a gate
  that is always `unmanaged`. Company resources (a shared login, a team server) are org-managed entries of the setting
  that holds them; no policy plugin decides who may create or bring anything. Design: `org-managed/book.md`.
- **(Superseded in its principals and session check by "People, apps and locks" and "The principal is identity only"; apps as trusted plugins stand.)** **Apps are plugins; users and guests are the confined people (owner, 2026-11-13: "an app is code, which creates
  layouts/views/objects it needs, and can reuse existing shit"; "the point of apps is that I the owner can construct
  it such that members (users) can only access what I give the app and its sessions"; "no defensive shit" for privacy
  against the owner; supersedes "Org-managed Pis through managed settings" of the same day):** one Pi, one owner, who installs every plugin; apps (the robot for his son, family, a football
  club, coding as the built-in app) are plugins and trusted: they call each other and any plugin freely. Only people
  are confined, by their principal: `owner`, `user { app, id }` (a member of one app's own user pool: invited by the
  owner, signs up on the app's page, configured by the owner per app), `guest { id, sessions: read | write, revision }`
  (p2's guest, from the same invite and sign-in path). Every object serves only the principals it knows (deny by
  default); users reach the rest through their app's objects (a remote object for users, the app's local store acting
  as the host behind it). One session check for every session view and object: the owner always; a user if the
  session's app says so (`Apps` registry: id, title, layout, `access`); a guest from its principal. What an app's
  sessions get is its worker facet's harness filters. For users the check depends on data, so it never runs in a
  factory: it runs in the session worker's route `authorize`, in methods and derives at use (workers ask the server's
  `SessionAccess`), and in HTTP handlers. Each app's own access rules are its own objects (her journal
  keyed by her id). Privacy against the owner is only an app's UI courtesy (he owns the machine and the code; no base
  machinery). Design and gaps (kit: per-app user pools and invites, revocation, current principals; harness:
  `scope.app`, fixed folder): `apps/book.md`.
- **(The person principal with roles, sessions and revision is superseded by "The principal is identity only"; locks are refined by "Locks".)** **People, apps and locks (owner, 2026-11-13, evening; supersedes the per-app user pools of "Apps are plugins; users
  and guests are the confined people", and with it `self.choose`; replaces the settings layer of "Org-managed Pis"):**
  everyone besides the owner is a **person** `{ kind: "person", id, name, roles: app → role, sessions: id → read |
  write, revision }`, rights in the principal as p2's guests ("maybe guest is sufficient"); a change bumps the
  revision and revokes. Identity is pluggable (providers with server, web and terminal parts); by default Radius
  (verified email; Google/GitHub at Radius) and this device; more devices by pairing. A session belongs to exactly
  one app; any app may show any session; the owner always passes. Lockdown is **locks**: a plugin declares a switch or
  a limit (`defineSwitch`, `defineLimit`: schema, open, closed, narrow), registers it with the server (`Locks`), and
  enforces it where it hands things out; layers company (the org profile: initial copy on disk, then Radius) > Pi >
  app (the app's code defaults, then the owner's app sheet) > session, only narrowing; one sheet per scope for
  technical owners, with the agent's help (`locks` tools). Plugins outside Pi's own root get a plugin switch per app
  (`otherPlugins: "on" | "off"` in the app, the owner chooses the apps on install); base plugins declare locks. Radius
  learns the locks from member Pis' reports and by loading selected plugins' server facets in a sandbox. Design, kit
  changes, open questions: `people/book.md` (second edition). The owner: "this still seems overly complex".

- **Direction (owner, 2026-11-13):** one Pi per person, one owner who installs every plugin; plugins (apps among them)
  are trusted code; only people are confined. Pi must be "super malleable, with basic primitives that allow almost
  everything": keep extension points cheap. Colin's plan: Dec 1 Pi Roam, Dec 18 Org Devices (each member their own Pi
  on an org machine), February hosted.
- **The principal is identity only (owner, 2026-11-13, late; supersedes the person principal with roles, sessions and
  revision of "People, apps and locks", the stamped principals, session lists in the principal and string-encoded
  session ids discussed that day):** `{ kind: "owner" }`, `{ kind: "person", id, name }`, plus `worker { session }`
  and `server`. Roles, shares and private sessions are data of apps and plugins, read live by admissions (below); a
  role change bumps no revision and revokes nothing. Identity is pluggable: identity-provider registries the people
  plugin owns (server; a web button; a terminal flow optional, a pairing code by default); built in: Radius (a
  verified email; Google or GitHub happen at Radius) and this device; more devices by pairing. No defensive machinery
  against the owner (privacy from him is an app's UI courtesy). A session's agent reaches other sessions only as its
  session's lock `conversations.reach` allows; it inherits no rights from its creator or sender.
- **Apps and sessions (owner, 2026-11-13):** an app is a plugin (its layouts, views, objects; it reuses any other
  plugin's); coding is the built-in app. A session belongs to exactly one app; any app may show any session; moving a
  session to another app is allowed (its app is a fact admissions read live; the locks of the new app's layer apply
  from the next turn). `defaultApp`: a Pi setting, per person a preference; new sessions without a choice and the start
  page go there; fallback coding. An app may admit another app's people (the robot lets family members watch).
- **Admission before the factory (owner, 2026-11-13; Chord):** `host.serve(Type, factory, { admit })`; `admit`
  declares references, registries and derives and returns a watchable `allow(level) | deny(reason)`; the factory gets
  the level. Design: `packages/chord/docs/admission/design.md` (reviewed by Opus, Astra, Sol, Fable; Fable's round 2
  not yet folded in). Open for the owner: the staging rule, dropping last values on a denial, the route staying coarse
  (recommendations in slice 4's brief). p3 use: `SessionsStore.facts` (keyed, server), `SessionAccess { session,
  person }` (server, held by the session's worker), each app's `access` rule in the `Apps` registry.
- **Locks (owner, 2026-11-13; refines "People, apps and locks"):** design in `archive/locks/design.md` (with Fable's
  review, slice 6). A plugin declares a lock (id, title and description as `MessageData`, schema, open, closed,
  `narrow`), registers it with the server (`Locks`), reads it (`lockValue`, `lockValueFor`) and enforces it where it
  hands things out; locks are static declarations, runtime things are values. Layers org > Pi > app (the app's code
  defaults, then the owner's app configuration) > session, only narrowing; one sheet per layer; `LockEditors`; the
  agent's `locks_*` tools from the owner's sessions. Locks take effect from the next turn: a running turn keeps its
  snapshot, no check at the call ("that's not a security boundary we need"). Plugins outside Pi's own root have a
  plugin switch per app and session (`otherPlugins: "on" | "off"` per app, the install dialog chooses the apps; an
  app's own plugin is always on); base plugins have none; an org's ban is the loader's admission. Every user-visible
  text in p3 is a message (`MessageData`, rendered per viewer); Radius gets the texts in reports. Radius learns locks
  from member Pis' reports, or when the admin says "analyse this plugin" (Radius loads its server facets in a sandbox
  and collects its `Locks`). Open: candidates (the sheet's possible values; Fable proposes a function next to the
  lock, called when the picker opens), the page side of the plugin switch, the kit and Radius changes.
- **The org profile is the top layer (owner, 2026-11-13):** enrollment file on disk (an initial copy), then what Radius
  delivers, signed, cached, followed live (`archive/org-managed/book.md` for enrollment, the gate and machine
  lock-down; its settings layer is superseded by locks).
- **Process rules (owner, 2026-11-13):** read docs and code in full before designing; never present invented APIs
  (every function shown is real, with its file, or defined right there); mark code BUILT or PROPOSED; never write
  about competing products in public repos; handoffs start with "Read first, in full"; docs may be committed, code
  only after the owner's review.
- **Tool access (owner, 2026-11-06, recorded in the archived handoff of that day):** a turn's `origin` (owner-only
  turns) is out, illusory against prompt injection; a tool's `scope` stays (structural: main conversation, subagents);
  no new fields on tool declarations; no hardcoded tool lists; script-only tools through Durable's
  `callers: ["tools"]`; without code mode the extensions registry's compose applies the `tool_search` fallback.
- **Models and credentials (owner, 2026-11-06 and 2026-11-07):** plugins can provide model providers; workers get only
  the access tokens of their session's providers, as view state, and the server refreshes them; each config file has
  one owner on the server, others follow its state and write through its methods. Third parties integrate sign-in and
  accounts; a plugin uses an account for an MCP sign-in or a provider (`archive/accounts/book.md`).
- **No per-user environments (owner, 2026-11-10, repeated 2026-11-13):** a session in any app may use every
  environment of the Pi; an app may limit its sessions to one; separation beyond that is a separate Pi.
- **Rejected (owner, 2026-11-13; do not propose again):** managed settings (`defineSetting`, a managed layer), a plugin
  manifest in `package.json`, per-plugin "features", permission levels, operation registries and policy rule tables,
  resource rows, a `plugins: { only }` list in app code, a generic "pick plugins per session" sheet, per-app user pools
  with `self.choose`, stamped principals, session lists in the principal, session ids that encode their app.
- **Two research notes stay in the repo (owner, 2026-11-13):** `archive/hermes-opencode-teams.md` and
  `archive/openclaw-teams.md` predate the rule against writing about competing products in public repos; the owner
  kept them. Nothing new of that kind goes into the repo.
- **Docs, slices and the workflow (owner, 2026-11-14):** `apps/p3/docs/` holds only the current working set
  (`README.md`, `overview.md`, `names.md`, `workflow.md`, `decisions.md`, `slices/`); everything older moved to
  `archive/`. p3 is built in small slices, each with a brief; before a slice is built its brief is filled out in
  detail; then build, review by Sol, Astra and Fable, fix, review again, fix, a walkthrough, and the owner's review with
  Fable; work stops whenever a decision comes up (`workflow.md`). The p3 session is the builder. Names are one per
  thing, everywhere (`names.md`): `transcript` (not chat), `person` (not user or guest), a run is the agent's work from
  an input to its answer, a turn one assistant answer plus its tool calls. Fast and low memory is a goal: every slice
  measures worker start, idle RSS, server start and bytes on the wire (p2's worker starts take seconds on the phone).
  The kit's plugin loading is kept.
- **No worktree (owner, 2026-11-14):** p3 is built in the shared checkout `/home/badlogic/pi` on main, as decided on
  2026-11-06 for the then branch; commit only your own files. The resource model stays superseded by locks: Fable's comparison
  (2026-11-14, private: `research/p3-people-2026-11-13/resources-vs-locks-adm-fable.md`) recommends locks (one owner
  leaves only restriction; several times smaller to build and for plugin authors) and three of its ideas for locks,
  open in slice 6.
