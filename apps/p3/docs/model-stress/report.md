# Stress test: p3's proposed data model against every p2 feature

Written on paper, without building anything. Sources: every plugin in `apps/p2/plugins/` (file headers, contracts and the
access checks of its server facet), `apps/p2/docs/` (remote-envs.md, discord.md, questions.md, workflows.md,
p3-functions/), `apps/p3/docs/accounts/book.md`, `apps/p3/docs/decisions.md` and `packages/chord/docs/design.md` §3–§7.

## Verdict first

The model's core holds. It says: resources are addressed things, plugins keep the facts, selectors compose
`SessionResources`, the server checks every hand-out, and credentials stay on the server. p2 already does this in a
narrow form, hardcoded for one owner:

- `SessionLock` is a restrict selector (`src/runtime/session-lock.ts`: picked MCP servers, project MCP, instructions,
  capabilities).
- The MCP manager is a per-session server view that checks the lock before it places anything
  (`plugins/mcp/placement.ts:97-129`).
- The worker never holds an MCP process or credential (`plugins/mcp/worker.ts`).

The model generalizes a mechanism that works today. Every p2 resource kind (models, MCP, environments, sandboxes,
instructions, capabilities such as ports and peer messaging) fits under it.

The model does not hold as stated in three places:

1. **Authority over a turn.** p2 decides per turn who started the work. The `origin: "owner"` tools are MCP tools
   (`plugins/mcp/tools.ts:154`), ports, peer conversations, location tools and reload. The model decides per session.
   As a result, anyone who can send input uses every selected resource. That includes project members, read/write
   guests and strangers in a Discord channel, and it includes resources other people lent.
2. **The policy's shape.** A policy of one provider, `variant(principal, Type, params)`, cannot do four things: combine
   facts that several plugins own, know the variants of third-party contracts, list what a user may see, or move live
   objects to a new variant when a grant changes or expires.
3. **The machine the server runs on.** In a multi-user p3, two things run code as the server's OS user: a session
   whose location is "this device", and an owner-configured stdio MCP server run on the server (decision 8). That code
   can read the vault, other users' stores, and API keys in worker memory. p2 is safe only because it has one owner.

The selection also needs richer entries than a set of addresses: which login, how narrow, and why each entry is
there. Location must be a core, per-conversation fact that stays inside the selection, not a folders-plugin fact.

**Recommendation:** keep the model and add the amendments in "Gaps" below. Gaps 1–3 are critical or high and change
the model. The rest are additions.

---

## The model, numbered for reference

- **M1 Addresses:** everything is a Chord object: contract name plus typed params.
- **M2 Plugin facts:** relations between addresses, kept in each plugin's own server tables. Groupings are views over
  these facts. A grouping either organizes (it changes what you see) or provides (its resources flow into its
  sessions).
- **M3 Selectors:** plugins contribute include and restrict selectors, `session → addresses`, computed live on the
  server. `SessionResources { session }` = union(includes) − anything a restrict excludes. It is pushed to the
  session's worker.
- **M4 Per-session server views:** `ProviderForSession { session, id }`, `McpForSession { session }` and the like
  check the selection on the server. The worker follows them and contributes to its registries. The data plane runs
  where it is cheapest.
- **M5 Vault:** one opaque JSON entry per (plugin, key, owner), one write path, refreshed once, on the server. Workers
  get resolved request auth, never a refresh token. A login is lent (the bringer's) or per person (the session
  owner's).
- **M6 Access:** Chord's `authorize` plus per-principal views. One pluggable policy answers
  `variant<C>(principal, Type, params)`.
- **M7 Users:** principals are `server | worker | user { id }`. Sign-in plugins find or create users. A user has N
  accounts in the vault.
- **M8 MCP:** a checkout's `.pi/mcp.json` is only a suggestion: enabled per checkout, run in that env and directory.
  Server-configured stdio servers run on the server machine. HTTP servers have no location. There is no `runOn`.

The words below mean:

- **Resource:** an address that can appear in `SessionResources`.
- **Lent:** the bringer's login is used.
- **Per person:** the session owner's own login is used.
- **Audience:** who can cause a session's turns.

---

## 1. Every p2 plugin through the model

Each entry gives five things:

- **Is:** what the plugin is in the model.
- **Facts:** what it keeps.
- **Selector:** what it contributes, if anything.
- **Gets:** what the worker, pages or terminals receive from the server, and how.
- **Credentials:** what secrets it uses.

**Misfit** says where the model does not fit or lacks something.

### Resources a session uses

**models**
- **Is:** the resource kind `ModelProvider { owner, id }`. Custom providers come from a user's (or the instance's)
  models.json. Settings (default model, cycling scope) are per-user facts.
- **Facts:** the provider configuration, and the default model and thinking level per user.
- **Selector:** none of its own. Providers come in through projects, bringing, or a defaults include.
- **Gets:** the worker holds `ProviderForSession { session, id }`: the model list plus pushed auth. It contributes the
  provider to the harness's `ModelProviders`. Today every worker reads `auth.json` and `models.json` itself and
  refreshes OAuth itself (`plugins/models/worker.ts`, `plugins/models/credentials.ts`). This is exactly what M5
  replaces.
- **Credentials:** vault, per (user, provider); lent or per person.
- **Misfit:**
  - Selection is per provider, but Radius and admins restrict per model (gap 3).
  - pi-ai's `AuthResult` has no expiry (`packages/ai/src/auth/types.ts:104`). The pushed state needs `expires` next
    to it.
  - The API key handed to the worker is a bearer key valid for every model of the provider, so a per-model
    restriction is enforced only by trusted worker code (gap 8).
  - A conversation's chosen model is transcript-bound. When it leaves the selection, the next turn must refuse with a
    visible error, as p2 refuses an unknown model at configure and at worker start.
  - Who pays is now a question (gap 16).

**login**
- **Is:** not a resource. It is the flow that writes vault entries (pi-ai `CredentialStore.modify` on the server).
- **Facts:** none. Entries live in the vault.
- **Selector:** none.
- **Gets:** pages get the per-user login flow, with questions per `docs/questions.md`.
- **Credentials:** writes the vault.
- **Misfit:** p2 allows one login at a time server-wide, owned by the starting device
  (`plugins/login/logins.ts`). In p3 this becomes per user. Otherwise it fits M5 directly.

**mcp**
- **Is:** the resource kind `McpServer { owner, name }`. A checkout's suggestion is
  `McpServer { checkout: (env, path), name }`, enabled by an explicit fact.
- **Facts:**
  - configured servers per user or instance;
  - enabled suggestions per checkout;
  - OAuth tokens (today `mcp-auth.json`, `plugins/mcp/credentials.ts`).
- **Selector:** none of its own, apart from suggestions enabled for a checkout, which include for sessions working
  there.
- **Gets:** the worker holds `McpForSession { session }`. This is p2's lease view almost unchanged: the worker sets the
  locations its conversations work at, the server places instances and serves tool calls (`plugins/mcp/leases.ts`,
  `placement.ts`). Tools reach the model through code mode or `tool_search`. No process or credential is in the
  worker. That is already true in p2 and stays true.
- **Credentials:** vault (OAuth tokens, header or env secrets), used only by the server-side supervisor.
- **Misfit:**
  - **Instances must be keyed by login.** A stdio server gets its token as an env var at spawn, so a per-person login
    means one process per (server, location, login), not p2's per session or shared.
  - **Tool names collide.** Two users' `github` servers produce the same `mcp__github__*` names. p2 refuses such
    collisions in a single file (`plugins/mcp/config.ts`, the namespace check). The union of several users'
    resources needs aliasing (gap 3).
  - **Decision 8 changes p2's default.** p2 runs a non-shared stdio server where the conversation works
    (`plugins/mcp/config.ts:111`, `defaultRunOn = "location"`). In p3 such servers can only come from a checkout's
    suggestion (gap 13).
  - **Server-run stdio servers execute code on the server machine** (gap 1).
  - **Per-turn authority.** p2 marks every MCP tool `origin: "owner"` (`plugins/mcp/tools.ts:154`): a guest's turn
    cannot call MCP. The model drops that (gap 2).

**envs** (SSH environments and Gondolin sandboxes)
- **Is:** a resource kind `Env { owner, name }`. It is also the place where tools, the workspace, terminals, prompt
  files and checkout MCP run. A location is (env, cwd).
- **Facts:**
  - configurations;
  - trusted host keys;
  - per-sandbox secrets (`plugins/envs/secrets.ts`);
  - the sandbox → host relation.
- **Selector:** a restrict for confinement. A conversation in a sandbox may use only that sandbox as a location
  (remote-envs.md, "Confinement").
- **Gets:**
  - Today the worker reads `envs.json` and the SSH identity file from the data directory and opens SSH itself
    (`plugins/envs/worker.ts:14-28`). It also passes sandbox secrets on the launcher's stdin.
  - Under M5 the worker may not hold the private key. It needs a signing oracle instead (gap 7).
- **Credentials:** SSH private keys and sandbox secrets. Neither is an HTTP `AuthResult`.
- **Misfit:**
  - **Credential kinds** (gap 7).
  - **Dependencies between resources.** A sandbox needs its host env's connection and key, but a session confined to
    the sandbox must not get the host env as a location. So "used to reach X" differs from "selected" (gap 7).
  - **Location ⊂ selection,** and what happens when an env leaves the selection mid-session (gap 5).
  - **Lending an env lends a shell account.** Everyone in the project runs `bash` as Cristina's user on `gpu`. The
    terms of the lending matter (gap 2).

**voice**
- **Is:** a resource kind `SpeechService {}` (instance). It is used by pages, not by the worker. The server relays
  browsers to it with a token from `voice.json` (`plugins/voice/server.ts` header).
- **Facts:** per conversation, the voice and the on switch (a Durable document); per guest, the microphone switch.
- **Selector:** whether a session may use it (an include from defaults or project).
- **Gets:** pages hold a per-session room route, checked against the selection and the principal's role. The worker
  gets only the prompt section.
- **Credentials:** the service token stays on the server.
- **Misfit:** M4 names only worker-facing views. Per-session views must also serve page principals (minor).
- **Rule to keep:** "only the owner speaks for Pi" and "read/write guests talk" become roles on
  `VoiceRoom { session, conversation }`.

**prompt** (AGENTS.md, skills, templates)
- **Is:** two different things:
  - The global instructions, skills and templates are a resource (`Instructions { owner }`). p2's lock already treats
    them as one (`instructions: bool`).
  - The project's files are read from the location and are part of the env.
- **Facts:** the user's global files.
- **Selector:** none. It is restricted by a lock.
- **Gets:** the worker loads through the conversation's env and reloads after a move (`plugins/prompt/worker.ts`).
  Global instructions would be pushed by the server.
- **Credentials:** none.
- **Misfit:**
  - In a project session it is unclear whose global instructions apply. The answer should follow the per-person
    rule: the session owner's.
  - Skills under the env's home (`~/.pi/p2/skills` on the remote) belong to whoever's account the env logs in as. A
    lent env lends its owner's skills too. Acceptable, but say it.

### Capabilities that reach beyond the session

**ports**
- **Is:**
  - A capability resource `PortForwarding {}` (p2's lock capability `ports`).
  - Forwards are things the session creates: `Forward { id }`, which exposes `localhost:<port>` of the server machine
    through Radius (`plugins/ports/protocol.ts`).
- **Facts:** forwards with the session that opened them (`plugins/ports/store.ts`).
- **Selector:** the capability is included by default for the owner; a lock restricts it.
- **Gets:** the worker calls the server's `Ports` view as a worker principal (`plugins/ports/server.ts:88-99`).
- **Credentials:** Radius's, on the server.
- **Misfit:**
  - **Per-turn origin.** The ports tool is `origin: "owner"`, locked to `ports` (`plugins/ports/tool.ts:75-76`).
  - **Who may open a forward's URL.** Today only the owner. In p3 the access should follow the session's audience
    (gap 11).
  - **A remote session cannot forward** (`plugins/ports/server.ts:92`). When it can, the forward's data plane is the
    env's, and the capability depends on the env.
  - **Process exposure.** A forward publishes a process to the internet. Its cleanup when the session is archived or
    the resource revoked must be a lifecycle hook (gap 9).

**conversations** (cross-session messages)
- **Is:** a capability whose targets are other sessions. The resources are `Session { id }` addresses.
- **Facts:** none. The broker uses the catalog (`plugins/conversations/server.ts:17-28` lists all unarchived
  sessions).
- **Selector:** peers. Default for one user: all of that user's sessions. In a project: the project's sessions.
- **Gets:** the worker principal calls the broker. The server checks that the target is in the sender's selection.
- **Credentials:** none.
- **Misfit:**
  - In p2 the list is "every session" and only owner-started turns may send. In multi-user both must narrow:
    Colin's session must not message Cristina's private session.
  - Sessions as resources work under M3, but the default include is needed (gap 12).
  - Sending wakes the recipient's worker. Who pays for that turn, under whose per-person login: the recipient
    session's owner. State it.

**locations**
- **Is:** agent tools over envs. They list the envs a conversation may move to and their directories, and they move
  the main agent when its turn ends (`plugins/locations/worker.ts`).
- **Facts:** the pending move (a Durable document).
- **Selector:** none. It reads the env resources in the selection.
- **Gets:** the worker calls `AgentLocations` as a worker principal (`plugins/locations/server.ts:11-60`). The server
  checks sandbox confinement.
- **Credentials:** none of its own.
- **Misfit:**
  - Listing becomes the env resources in the selection (good).
  - The `origin: "owner"` requirement (`plugins/locations/tool.ts:3`) is per turn (gap 2).
  - The move changes the location, which must be core (gap 5).

**dev-tools**
- **Is:** an admin capability. `reload_plugins` works only in a local session on the p2 checkout, only in an
  owner-started turn, and never in a locked session (`plugins/dev-tools/tool.ts:33-34`).
- **Facts:** none.
- **Selector:** include only for sessions of admins at the app checkout.
- **Gets:** a server dev endpoint.
- **Credentials:** none.
- **Misfit:** the capability is meant for one person's turns. A selection cannot express "only when an admin started
  this turn" (gap 2). It also requires a local location, which is gap 1's danger zone.

**terminals**
- **Is:** not a resource. Terminals are things that expose processes: `Terminal { session, id }` on the session's or
  conversation's location. They run in a detached terminal host on the server machine, which SSHes to envs
  (`plugins/terminals/envs.ts`). The agent's `terminal` tool drives the same terminals.
- **Facts:** the terminal list (the host's).
- **Selector:** none. The location's env must be in the selection.
- **Gets:**
  - Pages get an owner-only view and byte channel (`plugins/terminals/server.ts:54-66`).
  - The worker gets `AgentTerminals` as a worker principal (`plugins/terminals/server.ts:110-149`).
- **Credentials:** the env's SSH key. It is server side, so it fits M5.
- **Misfit:**
  - Terminals outlive server and worker restarts. Nothing in the model ends them when the env leaves the selection
    or a one-hour grant expires (gap 9).
  - Who may open a terminal: p2 says owner only. In p3 it is a role on the session plus the env (gap 6).
  - The env's "view" (a file browser and terminals with no session) needs the same env access without a session.
    That is a policy question on `Env`, not a selection question.

**powershell**
- **Is:** a harness extension. The tool is offered per conversation when its location's machine runs Windows
  (`plugins/powershell/worker.ts`).
- **Facts, selector, credentials:** none.
- **Gets:** nothing beyond the env.
- **Misfit:** none. It follows the location.

### Where tools run: harness features over the location

**coding-tools**
- **Is:** a harness extension (read, write, edit, bash) at the conversation's location through
  `HarnessEnvironments`.
- **Facts, selector:** none.
- **Gets:** the env connection.
- **Credentials:** the env's.
- **Misfit:** "Send access permits tool actions". Every audience member runs `bash` with the env's (possibly lent)
  login (gap 2). A local location means code runs on the server machine (gap 1).

**workspace**
- **Is:** a page view of a location's files: browse, git, diff, search, upload, review comments. It runs on the worker
  through the env (`plugins/workspace/protocol.ts`). The route checks `canSend` (`plugins/workspace/server.ts:26`).
- **Facts:** none on the server. Review drafts live in the browser.
- **Selector:** none.
- **Gets:** pages get a per-session, per-conversation view (role: writer).
- **Credentials:** the env's.
- **Misfit:** it fits as a role on the session. A "file" address (env plus path) also appears in groupings
  ("project files"). Its access must derive from the env, and from the session when it is reached through one
  (gap 11).

**file-index**
- **Is:** a worker-local completion index at the conversation's location (`plugins/file-index/worker.ts`).
- **Facts, selector, credentials:** none.
- **Misfit:** none. It is rebuilt after a move.

### Session content and harness features (not resources)

**chat**
- **Is:** the core conversation (worker) plus pages and terminals. These are per-principal views of
  `Chat { session, conversation }`, with variants owner, writer and reader.
- **Facts:** the transcript (Durable). Authors: p2's `Author { kind: owner|guest }` becomes user ids.
- **Selector:** none.
- **Gets:** state from the worker. The view's variant comes from the policy.
- **Credentials:** none.
- **Misfit:**
  - The variant must come from the session's sharing and audience, which another plugin owns (gap 6).
  - The shell commands (`!cmd`) run at the location (gap 2).

**chat-mode, drafts, tree, quiet-tools**
- **Is:** UI and worker features. They have per-conversation documents (chat-mode switch, restored drafts per author,
  `/tree` branches) or TUI display settings.
- **Facts, selector, credentials:** none.
- **Misfit:** only roles. "Owner switches chat mode" becomes a role on the session.

**codemode, agent**
- **Is:** harness extensions. Code mode is a QuickJS sandbox in the worker. One-shot agents are child conversations in
  the same session that inherit the location (`plugins/agent/tool.ts`, `docs/workflows.md`).
- **Facts, selector, credentials:** none.
- **Misfit:**
  - The tool set (MCP included) changes with the selection mid-script. p2 lets a running script keep its tool. In
    p3, a call to a removed resource must fail as a tool error (gap 9).
  - One-shot agents take a tool subset: per-conversation narrowing (gap 4).

**subagents**
- **Is:** conversations in the same session and worker (`plugins/subagents/tools.ts`). Each has its own model,
  thinking level, tool subset, and optional own location (env, cwd; `tools.ts:230-340`). Subagents cannot spawn
  subagents.
- **Facts:** the registry (Durable, transcript-bound) and the server's copy for the sidebar.
- **Selector:** none. The session's selection bounds them automatically.
- **Gets:** the same worker.
- **Credentials:** none.
- **Misfit:**
  - Not "sessions that inherit" but conversations that narrow. The tool subset is enforced in the harness.
  - Their own location must be ∈ the selection, checked like the main location.
  - A sandboxed caller's subagents stay in the sandbox (already per conversation).
  - See gap 4 and scenario (f).

**history**
- **Is:** agent tools over the calling conversation's own history. Searches go to the server index scoped by the
  worker principal (`plugins/history/worker.ts`).
- **Facts, selector, credentials:** none.
- **Misfit:** none.

**search**
- **Is:** a server index of all sessions' messages, fed by workers (`plugins/search/server.ts`). Search is owner-only
  (`:186`), and read marks are owner-only (`:154`).
- **Facts:** the index rows per (session, conversation), and read marks per user.
- **Selector:** none.
- **Gets:** pages get the per-user search.
- **Credentials:** none.
- **Misfit:** search reads across sessions. In p3 every hit must be filtered to sessions the user may view. That is
  enumeration, not one `variant()` call per item (gap 6). Read marks become per user.

**status**
- **Is:** a server index of worker reports (live tasks, busy conversations, spend), fenced by generation
  (`plugins/status/server.ts`).
- **Facts:** the reports.
- **Selector:** none.
- **Gets:** pages get the per-user list.
- **Credentials:** none.
- **Misfit:**
  - Lists need enumeration authority (gap 6).
  - Spend is per session only. With lent and per-person logins, spend must also be per login (gap 16).

**files, send-file, artifacts**
- **Is:** things created by a session. Each has an address:
  - uploads: `SessionFile { session, id }`;
  - download snapshots: `SessionFile { session, id }`;
  - artifacts: `Artifact { session, conversation, name, version }`.

  They are stored in the session worker's `Files` and served by server routes that check `canView` and `canSend`
  (`plugins/files/server.ts:159-217`).
- **Facts:** the file summaries mirrored to the server.
- **Selector:** none.
- **Gets:** pages get the routes, with roles inherited from the session.
- **Credentials:** none.
- **Misfit:**
  - Sharing one artifact without the session needs a grant on the artifact whose role does not come from its parent.
  - Data read from a lent resource (a file `send_file` pulled from Mario's laptop, MCP output in the transcript)
    stays after the resource is revoked. Revocation cannot take back data (gap 9, accepted).
  - Clone and fork copy these (gap 10).

**sessions**
- **Is:** core: the catalog (title, location, model, pin, archive), lifecycle (create, relocate, clone, fork,
  archive), and SessionLock (`plugins/sessions/locks.ts`).
- **Facts:**
  - the catalog rows;
  - the locks, which already are restrict selectors;
  - the location (gap 5);
  - the creator (needed by the on-call scenario).
- **Selector:** the lock is a restrict.
- **Gets:** the worker gets its start data and the lock mirror (`plugins/sessions/lock-worker.ts`).
- **Credentials:** none.
- **Misfit:**
  - Lifecycle events must be offered to every fact plugin: copy on clone or fork, cleanup on archive or delete. p2
    has them ad hoc (`SessionCopied`, `SessionArchived`; gap 10).
  - The lock also covers per-turn origin: "the lock replaces the owner-started check" (`src/runtime/tool-access.ts`).

**projects**
- **Is:** in p2, a project is a codebase's places on several machines (`projects.json`: name →
  `[{ env, path }]`) plus which sessions belong to it (`plugins/projects/contract.ts`). It is an organizing grouping
  with a location helper (`/move` to the project's place on another env). The model turns it into the providing
  grouping: members, resources, lent logins.
- **Facts:**
  - S ∈ P;
  - R ∈ P, lent by U, under some terms;
  - members of P;
  - P's places (checkouts on envs, which are env resources).
- **Selector:** include (P's resources for S ∈ P) and restrict (S ∈ P gets only P's resources).
- **Gets:** nothing directly. It acts through `SessionResources`.
- **Credentials:** none. It refers to vault entries.
- **Misfit:**
  - A copied session joins its source's project. Lifecycle hook (gap 10).
  - Lending terms (gap 2).
  - p2's places are the project's envs and checkouts. Keep them: they become the default locations and the env
    resources.

**web-shell**
- **Is:** a layout plugin: the default layout of sidebar, main area and panel.
- **Facts:** browser-local state.
- **Misfit:** none. Decisions 2026-11-07 already make layouts plugins.

**logs**
- **Is:** an admin view of diagnostics (`plugins/logs/contract.ts`: owner-only).
- **Facts, selector, credentials:** none.
- **Misfit:**
  - Logs of session S are tempting to show to S's participants. But redaction must cover every vault value, and a
    lent key leaked into worker stderr would then reach other users. Keep logs admin-only. Show users only
    structured notices.

**proxy-marker**
- **Is:** nothing. A proxy header removes device trust in host code (`plugins/proxy-marker/server.ts`).
- **Misfit:** this belongs at kit level. See principal provenance (gap 14).

### Identity, access, transports

**devices**
- **Is:** p2's owner device cookies and one-time tokens (`plugins/devices/owner-access.ts`). It becomes a sign-in
  plugin plus the kit's sessions (M7).
- **Misfit:** "only the localhost device owner may mint a token" is a power that depends on provenance (gap 14).

**sharing**
- **Is:** session audience facts:
  - link guests, by read or full mode;
  - people by email (authenticated by Radius);
  - grants with a revision for live revocation (`plugins/sharing/server.ts:126-160`).
- **Facts:** links, guests, grants.
- **Selector:** none. It feeds the policy and the audience (gap 2).
- **Gets:** pages get guest views.
- **Credentials:** link tokens.
- **Misfit:**
  - The guest principal is reserved in p3. The p2 grant revision lives in the principal so that a changed grant
    yields new objects. Users need the same (gap 6).
  - A read/write share "lets guests run commands on those hosts" (remote-envs.md). With lent resources, sharing also
    lends everyone's logins (gap 2).

**radius** is four things in the model:
- **A transport.** The relay turns browser channels into loopback requests marked as remote owner
  (`plugins/radius/relay-access.ts`). This sits below the model, at host and link level.
- **A sign-in plugin.**
- **A vault account** (the gateway's models, the MCP server).
- **A possible policy provider** (organization groups).

**Misfit:** the relay marks provenance, "owner, but no localhost powers" (gap 14). Ports and email sharing depend on
the Radius connection, a server-side integration with no session selection.

**discord**
- **Is:** an input source bound to a session, not a resource the session uses.
  - Bots are server-side integrations: tokens in `discord.json`.
  - Links bind a channel to a session, with a cursor, threads and who may wake Pi (discord.md).
  - Linking moves the session into a sandbox and locks it to picked resources.
- **Facts:**
  - bots;
  - links (channel ↔ session, wake rules, cursors, thread ↔ subagent);
  - pending replies.
- **Selector:**
  - a restrict: the picked resources, which today is the SessionLock;
  - an env restrict: the sandbox.
- **Gets:** the worker gets `DiscordIngress` (batches, turn answers, thread forks), server only.
- **Credentials:** bot tokens: vault, owner user or instance; used by the server only.
- **Misfit:**
  - Discord people are not principals. They are attributed authors of inputs the server delivers. They are audience
    members the model has no word for (gap 2).
  - Linking exposes lent resources to strangers. The bringer never consented (scenario g).

---

## 2. Scenarios

### (a) Colin, Cristina and Charlotta create a project; each brings resources; a session; Colin removes his MCP mid-run

Setup, in facts:

1. The projects plugin stores P with members {Colin, Cristina, Charlotta}.
2. Colin brings `McpServer { colin, linear }` (HTTP, OAuth). Fact: (linear ∈ P, lent by Colin).
3. Cristina brings `Env { cristina, gpu }`. Fact: (gpu ∈ P, lent by Cristina).
4. Charlotta brings `ModelProvider { anthropic }`. Fact: (anthropic ∈ P, per person).
5. Cristina creates S in P at `gpu:~/proj`. Facts: S ∈ P; location (gpu, ~/proj); owner of S = Cristina.

Composition:

6. The projects include for S yields {linear, gpu, anthropic}. The projects restrict for S keeps only P's resources.
   The result is `SessionResources { S }` = {linear, gpu, anthropic}, pushed to S's worker.

What the worker gets:

7. `ProviderForSession { S, anthropic }` checks that anthropic ∈ selection. The login is per person, so it uses the
   session owner's: Cristina's Anthropic entry. If Cristina has none, it reports "unavailable" (the model picker shows
   it unusable). It pushes `AuthResult` plus expiry, and the worker streams directly.
8. `McpForSession { S }` checks that linear ∈ selection. The server opens linear's connection with Colin's vault
   entry. Its key must include the login (an instance for Colin's login, not shared with someone else's linear).
9. The location gpu needs Cristina's SSH key. The worker may not hold it (M5), so the worker's SSH asks the server to
   sign (gap 7, fix). Without that fix, this step violates M5.

Charlotta sends "fix the bug":

10. Her turn uses Cristina's Anthropic login (per person means the session owner's, not the speaker's), Colin's
    linear token and Cristina's shell account on gpu. Nobody chose that combination for Charlotta's turns
    explicitly. Project membership implies it (gap 2: lending terms).

Colin removes linear from P while the agent is mid-script, calling `mcp__linear__search`:

11. The projects plugin deletes the fact. The selectors recompute: `SessionResources { S }` loses linear and the
    worker gets the new set.
12. On the server, `McpForSession { S }` drops S's need for linear. The supervisor closes linear's instance for
    Colin's login if nobody else needs it.
13. **Undefined in the model:** the in-flight call. Either it finishes (the token was already used) or its server
    call is aborted. The script then gets a tool error, and the prompt's `mcp_servers` section changes, which
    invalidates the prompt cache. A Durable replay of an interrupted linear call after a restart now fails.
14. **Not revocable:** linear's earlier output is in S's transcript, search index and possibly artifacts.

What breaks:

- the per-turn authority (gap 2);
- the SSH key (gap 7);
- the in-flight semantics (gap 9);
- the binding. If Charlotta had also brought linear into S directly with her own login, the union contains linear
  twice with different logins. The model has no rule for which login wins, or for whether removal from P removes
  it (gap 3).

### (b) A session locked down to a subset

1. The lock plugin (p2's `SessionLock`, generalized) keeps the fact (S locked to {anthropic, gpu}).
2. Restrict selector: anything outside the set is excluded. `SessionResources { S }` = includes ∩ {anthropic, gpu}.
3. `McpForSession` now places nothing. This is exactly p2's `placement.ts:125-129`.
4. Global instructions, ports and peer messaging must be addresses for the lock to name them. p2's lock has
   `instructions` and `capabilities` (`ports`, `conversations`). They become `Instructions { owner }`,
   `PortForwarding {}` and `Session { … }` peers. Fine under M1.
5. The location tools may move only to envs in the set. A sandbox is a restrict on locations.

What breaks:

- p2's lock also replaces the per-turn owner check (`src/runtime/tool-access.ts`). Without a per-turn concept, an
  unlocked shared session gives guests more than a locked one, which inverts p2. Gap 2.
- A restrict narrows only whole addresses. "anthropic, but only Haiku" or "linear, but read-only tools" needs
  narrowing (gap 3).

Otherwise this is the model's best case.

### (c) On-call: a prod env and a prod MCP only for sessions started by the on-call person

1. The on-call plugin keeps the schedule and a fact "on call now = U". A routine flips the fact at each handover:
   selectors are live over facts, so time must become a fact.
2. It needs the creator of S, a core catalog fact. The model never named it (gap 10/5: the core must expose session
   facts to selectors).
3. Include: if creator(S) = on-call(now), add {Env{instance, prod}, McpServer{instance, prod}}. Logins are instance
   vault entries (M5 allows owner = the instance).
4. Restrict: exclude prod resources from every session where that condition fails. Otherwise someone brings prod
   into their own project and the union lets it in. A restrict wins over every include, so this holds.
5. The handover happens at 09:00 during an incident. Under "on call now", the old on-call's session loses prod
   mid-incident: live recompute, and gap 9 for in-flight work. Under "started while on call", the plugin records at
   creation and needs a session-created hook (gap 10). Either can be expressed. The plugin chooses.

What breaks:

- The on-call person shares the incident session with a teammate, or links it to the incident Discord channel. Every
  audience member now drives prod (gap 2).
- The session's location is the prod env, and at the handover prod leaves the selection. The location becomes
  invalid while `bash` may be running there (gap 5).
- Terminals the on-call person opened on prod keep running (gap 9).

### (d) Cristina gets Mario's laptop env for one hour

1. Mario's laptop is `Env { mario, laptop }`. Probably not SSH-reachable; that is a transport question, outside the
   model.
2. The grant "Cristina may use laptop until 15:00" is the policy plugin's data (M6). The variant for
   (Cristina, Env{mario, laptop}) is `user` until 15:00, then undefined.
3. Cristina brings laptop into her session S2. Fact: (laptop ∈ S2, lent by Mario). The selection includes it, and the
   worker connects with Mario's key through the signing oracle.
4. At 15:00 the policy answer changes, but the "brought into S2" fact remains. Nothing removes laptop from
   `SessionResources { S2 }` unless an ACL restrict selector re-checks the policy for the bringer or the session
   owner on every recompute. The model lists "an ACL plugin restricts", so the ACL plugin must contribute that
   restrict and re-run it at expiry (time is a fact again).
5. Live objects bound with the `user` variant at 14:00 stay bound. Chord chooses the variant in the factory. Only a
   revocation or a restart re-chooses it (design.md §4: revocation by `revokedBy` keys; `user { id }` carries no
   grant revision, so revoking would end all of Cristina's objects). Gap 6.
6. After 15:00 (gap 9):
   - a terminal Cristina opened on the laptop is still running in the detached terminal host;
   - a `bash` in flight finishes;
   - files `send_file` copied off the laptop stay in S2.

What breaks: the live re-variant, cleanup scoped to the resource, and the restrict that re-checks policy. All three
are needed for an expiring grant to mean anything.

### (e) A Radius-org policy plugin restricts model use by Radius group

1. The Radius policy plugin follows each user's groups (accounts book, "Bring Your Own Org Model").
2. As a restrict selector: for S, exclude providers or models the relevant person's groups cannot use. The open
   question is who the relevant person is:
   - the session owner;
   - the bringer;
   - every member of the audience (the intersection);
   - the person whose message started the turn.

   In P, Colin (eng: Opus allowed) and Charlotta (support: Haiku only) share S. A per-session selection must choose
   the owner or the intersection. Per-turn, which is what the org means, is not expressible (gap 2).
3. Granularity: Radius gates models, the selection holds providers (gap 3).
4. Enforcement: if the provider is Radius's gateway, Radius enforces with the user's own token (per-person login).
   This is clean. If it is a lent Anthropic key, p3 enforces only in the worker. The key works for every model, and
   anyone with `bash` at a local location can read it from worker memory (gaps 8, 1).
5. A group change in Radius reaches the plugin on its refresh. The restrict recomputes and the selection shrinks.
   Fine. Variants of model-picker views need the live re-variant (gap 6).

What breaks: per-turn identity, model granularity, and bearer keys. "Restrict by group" works as long as the session
owner's group decides and Radius's gateway is the provider.

### (f) A subagent spawned from a project session

1. In p2 a subagent is a conversation of the same session and worker (`plugins/subagents/tools.ts`), so it is under
   `SessionResources { S }` automatically. Nothing to compose.
2. Its tool subset is harness-level narrowing. An MCP subset is not expressible in p2 today either. The one-shot
   `agent` takes "read, write, edit, bash, send_file, artifact" (workflows.md).
3. Its own location (env, cwd) must be ∈ the selection. Today the check is that it exists and the sandbox rule
   holds. It must also check the selection. The MCP lease adds that location, and its checkout suggestion is shown,
   not run.
4. The selection changes mid-run: the change applies to all conversations at once. Fine.

If p3 ever makes subagents separate sessions (for parallel workers, delegation to another user, or a Discord thread as
its own session), the subagents plugin contributes include = parent's selection and restrict = parent's selection
(inherit, never widen). Narrowing below that is a lock (restrict) on the child.

What breaks: nothing structural. Per-conversation narrowing stays a harness concern (gap 4), and the own-location
check must use the selection.

### (g) A Discord channel bound to a session in a project; guests talk to it

1. Cristina links S (∈ P) to #support through the instance's bot. Discord facts: the link, the wake rules and the
   pick. The policy decides whether she may use the bot.
2. Discord contributes restricts: the picked set (p2's lock) and env = the chosen sandbox. The projects include gives
   P's resources. The result is P's resources ∩ the pick, with a sandbox location.
3. A stranger @-mentions Pi. The server builds the batch and delivers it as an input authored "Name · Discord". The
   stranger is not a principal, just an attributed author (discord.md, "Batch").
4. The turn uses everything in the selection: Colin's lent linear if Cristina picked it, and Cristina's per-person
   Anthropic login.
5. A Discord thread forks a subagent in the same session (f).

What breaks:

- **Consent.** Colin lent linear to project members. Cristina, alone, exposed it to anyone in #support. The model's
  facts have no terms ("lent to members only" vs "to any audience"). Nothing checks the session's audience against
  them (gap 2).
- **Where policy would apply.** M6 answers per principal, but the input carries no principal. The policy cannot apply
  to Discord people at all. Their access is the Discord plugin's wake rules plus the selection.
- **Cost.** Per-person means Cristina pays for strangers. Acceptable if shown at link time.

### (h) A session moves its working location to another env mid-session

1. The owner chooses Relocate to `lab:~/proj`, or the agent's `location_move` defers it to the turn's end
   (`plugins/locations/worker.ts`).
2. The model must check lab ∈ `SessionResources { S }`. If S is in P and lab is not P's, the move is refused unless
   lab is brought in first.
3. p2's steps: fence the worker; update the catalog and each following conversation's cwd (transcript-bound,
   Durable); reopen the env, prompt resources, workspace watches and file index; close the old connection unless a
   subagent with its own location still works there (remote-envs.md).
4. MCP: the leases move to lab. The suggestions in the lab checkout's `.pi/mcp.json` are not enabled there, even if
   the same repository's suggestions were enabled at gpu. Expected under M8, but visible.
5. The SSH login switches to lab's: lent by another person, possibly.
6. Terminals stay where they were started. Ports: a remote env still cannot forward.

What breaks:

- M2 lists location as a folders-plugin fact ("session S works at slayer:~/pi"). In p2 it is per conversation,
  transcript-bound, moved under a fence, and read by core at worker start.
- If selectors read the location (sandbox restricts, checkout suggestions, "everything in ~/prod-repo gets prod MCP"),
  the selection depends on the location. The move and the new selection must commit in one fence. Otherwise the
  worker briefly has the new location with the old selection.

This is gap 5.

### (i) p3 single-user on a laptop, no projects

What is needed and visible:

- One user, created at first start. The default policy gives them everything (M6). No groups, no grants.
- The vault holds their logins. Every login is per person and the person is always them, so lent vs per person never
  shows.
- No projects plugin. A session "gets what was brought into it", so the user would bring every MCP server and
  provider into every session. p2 enables every configured MCP server (the `enabled` flag) and every signed-in
  provider by default. Without a defaults include ("my resources marked default go into my sessions"), this is a UX
  regression (gap 12).
- Selectors: the defaults include, plus the sandbox confinement restrict. `SessionResources` exists but is
  invisible. A "Resources" panel per session can stay hidden until something differs from the defaults.
- Per-session server views add one push per provider. The worker no longer reads `auth.json` itself. Cost: none
  noticeable.
- Decision 8: the user's stdio MCP servers now run on the laptop even when the session works on `gpu`. In p2 they ran
  on gpu by default. This is a regression for remote-env users (gap 13).
- Gap 1 does not apply (one user).

Verdict for (i): the model costs one defaults include and nothing else visible. That is the right amount, provided
gap 12 ships on by default.

---

## 3. Gaps, ranked, each with a fix

### 1. Critical: code runs on the server machine

**Problem.** Two things run arbitrary code as the server's OS user:

- a session whose location is "this device";
- a server-configured stdio MCP server (M8).

That user can read the vault, every user's session store, and the environment or memory of workers holding lent API
keys. p2 is safe because its owner is the only user.

**Example.** Charlotta, a project member, runs `!cat ~/.p3/server/store.sqlite | strings` in a local-location session.

**Fix:**
- Make the local location and server stdio MCP an admin role (the policy answers it). Everyone else works on envs or
  sandboxes.
- Run workers and server MCP processes as a separate OS user, or in a Gondolin sandbox on the server machine. Keep
  the vault readable only by the server process, encrypted at rest with a key the worker user cannot read.

This is a deployment rule plus one policy role. The model itself is fine.

### 2. Critical: who drives a session

**Problem.** p2's authority is per turn: `origin: "owner"` on MCP, ports, conversations, locations and
`reload_plugins` (`src/runtime/tool-access.ts`, `plugins/mcp/tools.ts:154`). A lock replaces it. The model's
selection is per session, so every member of the audience uses every resource with whoever's login it carries. The
audience is project members, read/write guests, people shared by email, Discord people, and peer sessions.

**Fix:**
- A core composed fact `SessionAudience { session }`: who can cause turns, contributed by sharing, projects, Discord
  and conversations.
- Every lending fact carries terms: `{ drivers: "bringer" | "members" | "audience" }`.
- A core restrict selector excludes a lent resource whose terms do not cover the current audience. When Cristina
  links S to Discord, Colin's members-only linear drops out, and the link sheet says why.
- Keep the selection per session. It stays live and pushed. Per-turn origin remains only as a tool requirement for
  admin-only tools (`reload_plugins`). This replaces p2's owner-turn check with consent that can be checked.
- Make it explicit that per person means the session owner's login, whoever speaks. Show it in the share and link
  sheets.

### 3. High: selection entries need more than an address

**Problem.** `SessionResources` as a set of addresses cannot say:

- which login a resource uses (lent by whom, or per person);
- how narrow it is (models of a provider, tools of a server, paths of an env);
- why it is there (which selector).

It also has no rule when two includes bring the same server with different logins. Two users' servers named `github`
collide in tool names.

**Fix:**
- Entries are `{ address, login: { lent: user } | { perPerson: true } | { instance: true }, narrowing?, via:
  selectorId[], alias }`.
- Restricts intersect narrowings.
- Login conflicts resolve by declared precedence (session bring > project > defaults) and are reported in the
  session's resources panel.
- The composer assigns aliases that are unique per session (`github`, `github_colin`).
- Per-session views use `login` and `narrowing`. They never look the login up on their own.

### 4. High: per-conversation scope

**Problem.** Subagents, one-shot agents and Discord thread subagents are conversations in the same session, each with
its own tool subset and location.

**Fix:**
- Define the conversation's scope as `SessionResources` ∩ the conversation's narrowing, enforced by the harness (tool
  subsets) and by the location check (gap 5).
- Keep subagents inside the session.
- If a later feature makes child sessions, the child gets the parent's selection as include and restrict.

### 5. High: location is core, per conversation, and must stay inside the selection

**Problem.** A location is transcript-bound per conversation, moved under a fence, and read at worker start. M2 makes
it a folders-plugin fact. Nothing in the model keeps it inside the selection or says what happens when its env leaves
the selection.

**Fix:**
- The location lives in the sessions catalog and the harness. The folders grouping is a view over it.
- Invariant: every conversation's `location.env` ∈ `SessionResources`.
- Relocation checks the target and commits the new selection in the same fence.
- When an env leaves the selection, tools at that location refuse (p2's behaviour for a deleted env), the session
  shows "location unavailable: relocate", and resource cleanup runs (gap 9).
- Expose core session facts (creator, location, audience) to selectors.

### 6. High: the policy's shape

**Problem.** A single provider answering `variant(principal, Type, params)` fails in four ways:

- (i) It cannot combine facts owned by several plugins: sharing, projects, on-call, expiring grants, Radius groups.
- (ii) The policy plugin would have to know every contract's variant names, third-party ones included.
- (iii) Lists need enumeration: sidebar, search, status, peers, forwards.
- (iv) Chord fixes the variant at factory time. A policy change re-chooses it only through revocation, and
  `user { id }` has no revision, so revoking is all-or-nothing per user.

**Fix:**
- (a) The policy answers roles, `role(principal, thing): Role | undefined`. Contracts map roles to their own variants
  at declaration, so the policy needs no variant names.
- (b) Grants are a registry composed like selectors: plugins contribute grant and deny rules (sharing: audience roles
  on `Session`; projects: member roles; time-limited grants), and one base provider supplies the org model (default:
  the first user is admin; Radius: groups).
- (c) `visible(principal, kind)` as a live set or table predicate, for lists.
- (d) Chord: a live object may declare `self.restartOn(readable)`. A change of its principal's role restarts the
  factory, and references move to the new variant. Chord already moves references across variants on a restart
  (design.md §7), so only the trigger is new.
- (e) Roles inherit through a parent relation: a session's files, artifacts, forwards and terminals follow the
  session (gap 11).

### 7. High: credential kinds beyond request auth

**Problem.** M5's "workers get `AuthResult`" covers HTTP model auth only, and pi-ai's `AuthResult` has no expiry
field (`packages/ai/src/auth/types.ts:104`). p2 also has:

- SSH private keys, read by the worker today (`plugins/envs/worker.ts`);
- sandbox secrets, passed by the worker on the launcher's stdin (`plugins/envs/secrets.ts`);
- MCP OAuth tokens (server only already);
- Discord bot tokens and the voice service token (server only).

Also, a sandbox needs its host env's key without the session getting the host env.

**Fix:** each resource kind declares how its credential is delivered:

- `pushed`: `AuthResult` plus `expires`, for models.
- `signing`: an ssh-agent bridged over Chord. The worker's SSH sets `SSH_AUTH_SOCK` to a local socket forwarding sign
  requests to a server object that checks the selection. The key never leaves the server. Known-hosts lines are
  pushed as state.
- `server-only`: MCP, bots, voice, and sandbox start. Sandbox start moves from the worker to the server.

Resources declare dependencies that the server resolves (sandbox → host env) without adding them to the selection.

### 8. Medium-high: lent keys in the worker are bearer secrets

**Problem.**
- A pushed Anthropic key works for every model and lives in worker memory. Per-model restriction (scenario e) is
  enforced only by worker code.
- With a local location, the agent can read the key (gap 1).

**Fix:**
- Gap 1's isolation.
- For lent logins whose bringer asks for it, an optional server-side model proxy, which moves the data plane to the
  server.
- Prefer short-lived tokens (OAuth) over static keys for lending.

### 9. Medium: what removal means mid-run, and cleanup scoped to the resource

**Problem.** The model does not define what happens to:

- in-flight tool calls;
- running scripts;
- Durable replays of interrupted calls;
- MCP processes;
- terminals in the detached host;
- forwards;
- running sandboxes;

once a resource leaves the selection or a grant expires.

**Fix:** one rule:

- Removal takes effect for new calls at once. In-flight calls finish (soft) unless the remover chose "revoke now",
  which aborts them.
- Replays of calls to removed resources become tool errors.
- A core registry `ResourceLeft { session, address }` lets each plugin stop what it started under that pair:
  terminals on the env, forwards, MCP leases, sandbox sessions.
- Data already in the transcript, index or files stays. Say so in the UI.

### 10. Medium: lifecycle of facts

**Problem.** Clone, fork, archive and delete each need a per-fact decision:

- the project follows a copy (p2 does this);
- a Discord link does not;
- a lock should, probably;
- a time-limited grant does not;
- a delete removes everything.

p2 has this ad hoc (`SessionCopied`, `SessionArchived`).

**Fix:** a core `SessionLifecycle` registry (created, copied, archived, restored, deleted). Every fact plugin
contributes its rule. Delete must call all of them, which p2 lacks.

### 11. Medium: things a session creates

**Problem.** Files, artifacts, forwards, terminals, thread subagents and peer messages are addressed things whose
access follows their session. Sometimes they are shared on their own: a public artifact, a public forward.

**Fix:**
- A core `parent` relation (thing → session → owner user), used by role inheritance (gap 6e).
- Direct grants on a thing override the inheritance.
- Public exposure (`Forward.public`) is a role for "anyone", visible in the session's resources panel.

### 12. Medium: defaults

**Problem.** A session outside every project gets only what was brought into it. Scenario (i) then makes the single
user bring every resource to every session. p2 enables every configured server and signed-in provider.

**Fix:** a shipped include selector, "my defaults": a user's resources marked default go into that user's sessions
outside providing groups. A project's restrict still overrides it.

### 13. Medium: decision 8 loses "run where the code is"

**Problem.**
- p2 runs non-shared stdio servers at the location by default (`plugins/mcp/config.ts:111`). M8 runs configured stdio
  servers only on the server machine. A server that must sit next to the code (filesystem, LSP, browser tools on
  gpu) now works only as a checkout suggestion.
- Enablement per checkout is global: Colin enabling a suggestion runs it in Cristina's sessions at that checkout.

**Fix:**
- Let a user configure a stdio server on an env resource (its address carries the env; this is not a `runOn`
  setting). It is usable only by sessions that have that env.
- Make checkout enablement per (checkout, user) or per (checkout, project).

### 14. Low-medium: principal provenance

**Problem.** p2 separates the local device owner from a relayed or remote owner:

- minting device tokens is localhost-only;
- the relay marks requests (`plugins/radius/relay-access.ts`);
- MCP sign-in picks a loopback or relay callback.

`user { id }` loses this.

**Fix:** `user { id, via: "local" | "relay" | "remote" }`, stamped by the link and part of the principal key (design.md
§4 already says the key should include provenance).

### 15. Low: inputs and exposures have no category

**Problem.** Discord channels, voice rooms and peer messages are inputs. Forwards and public artifacts are exposures.
None of them is something a session uses.

**Fix:** these need no new mechanism. Inputs feed the audience (gap 2). Exposures are things with a parent and a role
(gap 11). Name both in the model so that plugin authors stop forcing them into `SessionResources`.

### 16. Low: cost attribution

**Problem.** Spend is per session (`plugins/status/worker.ts`). Lent and per-person logins need spend per (session,
login) for budgets and for "Cristina pays for #support".

**Fix:** the worker reports spend per login. The vault entry's owner sees it.

### 17. Low: time

**Problem.** Expiring grants and on-call handovers need selectors that recompute at a moment in time. Derives have no
clock.

**Fix:** policy and fact plugins write time-driven facts from a routine (sleep until expiry, then commit). This is a
documented pattern, not a mechanism.

---

## 4. Cost: core vs plugins

Rough sizes, by analogy with p2 code of similar scope. Estimates, not measurements.

| Part | Where | Size |
| --- | --- | --- |
| `Selectors` registry, `SessionResources` composer with entries carrying `login`, `narrowing`, `via` and `alias`; push to the worker; resources panel data | core plugin | ~1–1.5k lines + tests |
| `SessionAudience` composer, lending terms, the terms restrict (gap 2) | core plugin | ~400 |
| Vault and accounts (accounts book), plus `expires` with `AuthResult` | core plugin (already planned) | ~1k |
| Roles policy: the role → variant mapping in contracts, the grants registry, `visible()` (gap 6) | core plugin + API | ~600 |
| Live re-variant: `self.restartOn` for live objects (gap 6d) | Chord (a decision) | ~200–400 + tests |
| Location in core, the location ∈ selection invariant, move + selection in one fence (gap 5) | sessions core plugin | ~400 on top of relocation |
| `SessionLifecycle` and `ResourceLeft` registries (gaps 9, 10) | core | ~200 |
| Principal `via` (gap 14) | kit | small |
| Server-machine isolation: separate OS user or a sandbox for workers and server MCP; vault at rest (gap 1) | ops + kit | large; outside the model, but blocks multi-user |
| Default policy (first user is admin) and a "my defaults" include (gap 12) | plugins | ~300 + ~150 |
| `ProviderForSession` and the models worker side | models plugin | ~300 |
| `McpForSession`: p2's leases and placement, keyed by login, aliases, env-addressed stdio servers | mcp plugin | port of ~3.3k, ~500 new |
| ssh-agent bridge, known-hosts push, sandbox start on the server | envs plugin | ~600 |
| Projects (members, resources, terms, places; include + restrict; copy hook) | projects plugin | ~700 |
| Lock as a restrict (exists in p2) | sessions or lock plugin | ~200 |
| Discord: restrict + audience contribution + consent check at link | discord plugin | ~150 delta |
| Sharing as audience and roles | sharing plugin | ~250 delta |
| Terminals, ports: `ResourceLeft` cleanup, parent relation | their plugins | ~100 each |
| On-call and a Radius policy (examples of third-party plugins) | plugins | ~300 / ~400 |

**Summary of the split:**

- **Core** grows by the composer, audience, roles policy, lifecycle registries and the location invariant: about
  3–4k lines plus one Chord change.
- **Each resource plugin** adds a per-session view and a delivery kind for its credential: a few hundred lines each.
  Most of the logic exists in p2.
- **The largest cost is not code in the model at all:** isolating execution on the server machine (gap 1). Without
  it, multi-user p3 is unsafe whatever the model says.
