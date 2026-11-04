# Plugin hooks

**Outdated: describes p2 on Chord v1** (before the move to Chord v2; Chord v1 is deleted, so its APIs such as
`self.register` and objects of lifetime "host", and the `packages/chord/src/old` paths cited below, no longer exist).
The registries and hooks are largely the same on v2; how p2 uses Chord v2: `p2-notes.md` **Chord v2**.

Reference of everything a p2 plugin could hook into, per facet. Paths are relative to `apps/p2/` unless they
start with `packages/`. "Owner/guest" says which principals reach a hook's effects; facet code itself is trusted code
that the server or the visitor's process runs.

How plugins are loaded (and the planned single pipeline) is in [plugin-loading.md](plugin-loading.md). How to write
one, step by step: Chord's [tutorial](../../../packages/chord/docs/tutorial/). TUI design: [p2-tui-port.md](p2-tui-port.md) §6-7.

## 1. Cross-cutting

### 1.1 Facets and how they load

| Facet | File | Loaded by | Runs as |
| --- | --- | --- | --- |
| Server | `plugins/<name>/server.ts` or `server.tsx` | Chord `nodeLoader` via `PluginRuntime.loader` (`src/hosts/plugins.ts`), alphabetical order | server host, `host.name === "server"` |
| Worker | `plugins/<name>/worker.ts` or `worker.tsx` | same, in every session worker, from the list in its init (`src/hosts/worker.ts`) | `session:<id>` host |
| Web | `plugins/<name>/web.ts` or `web.tsx` | `buildWebBundle` bundles selected facets; `startWeb` installs them (`src/hosts/bundles.ts`, `src/hosts/web/main.tsx`) | browser client host |
| TUI | `plugins/<name>/tui.ts` or `tui.tsx` | `buildTuiBundle` bundles selected facets; `setupTui` installs them with the core facet (`src/hosts/bundles.ts`, `src/hosts/tui-worker-runtime.ts`) | locked-down worker on the visitor's machine |

A facet is `defineFacet((host) => …)`. There is no manifest and no derived dependency list: a plugin needs what it
holds, resolved by contract name at runtime (`docs/plugin-loading.md` 4.2).

### 1.2 `contribute()` and registries

`contribute(host, name, register)` (`src/runtime/contribute.ts:10`) serves a local object of lifetime "host" whose factory only
calls `self.register(Registry, { key: value })`. Registrations live exactly as long as that object: a reload replaces
them, removing the plugin removes them. Only objects of lifetime "host" may register (`packages/chord/src/old/object.ts`).

```ts
export default defineFacet((host) =>
	contribute(host, "p2.web-envs", (self) => self.register(Slots, { "sidebar-foot:envs": EnvsButton })),
);
```

A plugin that needs state, resources or other objects serves its own object of lifetime "host" and registers from its factory
(e.g. `plugins/codemode/worker.ts:39-60`, `plugins/terminals/server.ts:10-30`).

Registries are plain descriptors (`defineRegistry`, `packages/chord/src/old/registry.ts:11`):

- **Conflict mode.** `"error"` (default) or `"last"`. Every p2 registry uses `"error"`; `TuiSlots` and
  `SessionArchived` get it by default. Two objects registering one key make the table build throw
  `registry_conflict` (`packages/chord/src/old/host.ts:608-623`), which refuses the load or reload. `"last"` is unused.
- **Order.** A table iterates in host-wide first-registration order of its keys, stable across reloads
  (`packages/chord/src/old/host.ts:625-638`). "Ordered" registries sort keys instead: `ordered()` with numeric-aware
  compare and `<order>:<plugin>` keys (`src/runtime/tui-renderers.ts:48`), `ComposerExpanders` by key
  (`src/runtime/composer.ts:10`), TUI prefix slots by key (`src/runtime/tui.ts:266-271`). Web `SlotList` uses
  registration order (`src/runtime/web.tsx:77-88`).
- **Where defined.** Runtime registries live in `src/runtime/*`; plugins define their own in `contract.ts`
  (`SendRouters`, `TranscriptEntries` in `plugins/chat/contract.ts:256,270`; `SessionArchived` in
  `plugins/sessions/contract.ts:58`). Using one imports that plugin, i.e. depends on it.
- **Reading.** `host.registry(R).table(ctx)` / `.get(key, ctx)` inside calls, `.subscribe(fn)` for live tables;
  web: `useRegistry(R)` (`src/runtime/web.tsx:52`).

### 1.3 Contracts and references between facets

- `local(name, …)` types are host-internal (only facets of the same host get them); `remote(name, …)` types are
  reachable over links, with one **variant per principal** chosen by the factory (e.g. `Chat` viewer/participant,
  `plugins/chat/contract.ts:195-243`). A factory that throws `forbidden()` denies.
- Placement: every remote contract says where it lives, `host: serverHost` or `host: sessionHost`
  (`src/runtime/chord.ts`; `sessionHost` places an object on `session:` + its input's `session`). Callers never name a
  host: a `get` goes where the contract places it, and the server routes `session:` to the worker, spawning it. Web and TUI hold server and worker objects; workers hold server objects with a
  worker principal.
- References: web `useObject` (re-gets after `gone`, `src/runtime/web.tsx:139`); TUI `TuiScope.watch` (backoff,
  stops on permanent refusals, `src/runtime/tui.ts:77-146`); backend `self.get` (as a resource dependency) or
  `ctx.get` inside calls; code outside Chord calls (Durable tools) uses `host.root`.

### 1.4 Principals

`src/runtime/principals.ts`: `P2Principal` is `owner` (`access: "local" | "relay" | "device"`, `device` with
`"device"`), `guest` (one session, `mode: "view" | "full"`, grant `revision`), `worker` (session + generation, stamped
by the server route), `server` (the server's own requests on a worker) and `host` (a host's own code). Plugins import
`defineFacet`, `Ctx`, `Host` and friends from `src/runtime/chord.ts`, Chord's API typed by `P2Principal`, so factories
narrow on `principal.kind`. Helpers: `isOwner`, `isGuest`, `isWorker`, `canView`, `canSend`, `authorIdOf`, `authorOf`.
`mayReach` (`src/runtime/server.ts:158`) adds `SessionAccess`.

Who gets which facet code: web and TUI facets are the same for owners and guests (both receive the selected facets'
bundles; `src/hosts/web.ts`, `src/hosts/server.ts`). UI gating (`useOwner()`, TUI `when: "owner"`) is cosmetic;
contracts and factories are the enforcement.

### 1.5 Hot reload per facet

| Facet | Trigger | What happens |
| --- | --- | --- |
| Server | explicit only: Reload button, `npm run reload`, `reload_plugins` (dev mode; `docs/p2-notes.md` "Dev mode") | Chord cluster transaction with every running worker: compatible changes keep state and resources; registrations swap atomically; contract/state changes need versions or migrations; a `registry_conflict` or failure keeps the old code. `src/runtime`, `src/hosts` need a restart. No reload without `P2_DEV=1`. |
| Worker | same transaction | as server; new workers spawn with the committed list. A Durable phase keeps the extension snapshot it started with (`src/runtime/durable.ts:35-41`); `ExtensionSwitches` changes apply to the next phase. |
| Web | backend reload builds a new content-named bundle; a visible page polls `/__p2_web` every 5 seconds | Facets are installed once per page (`startWeb`, `src/hosts/web/main.tsx`); any manifest-version change reloads the page. Foregrounding checks immediately; at most two previous generations remain available for up to 60 seconds. |
| TUI | backend reload builds a new bundle; the launcher polls the hash every second; `/reload` | Whole worker swap carrying bounded UI state (`docs/p2-notes.md` "TUI"). Within one worker: a `TuiCommands` change closes overlays (`src/runtime/tui.ts:461-465`); a changed `TuiSlots` value disposes and recreates that surface (`:471-485`). |

## 2. Server facets

### 2.1 Objects the server host serves

| Contract | Kind | What | Pointer |
| --- | --- | --- | --- |
| `Server` | local, lifetime "host" | `info` (dataDir, fake, allowedHosts, port), `revokeOwners`, `revokeGuests`, test `resourceOptions` | `src/runtime/server.ts:44` |
| `Hosts` | local, lifetime "host" | `workers` (per-session running/generation/pid/error), `stop` | `:185` |
| `HostLifecycle` | local | `manager` (opaque `SessionHosts`: `pause`, `relocate`, `retry`, `stop`) | `:194`, `:228-493` |
| `Access` | remote | caller is owner, or guest with its grant | `:535`, `src/runtime/access.ts:14` |
| `TuiPreferences` | remote | server defaults for TUI keys/theme/settings (`tui.json`) | `src/runtime/tui-preferences.ts:52` |

### 2.2 Registries

| Registry | Key → value | Consulted | Used by | Notes |
| --- | --- | --- | --- | --- |
| `Routes` | `"METHOD /path"` or `"METHOD /prefix/*"` → `(req, res, {principal, origin}, ctx)` | after host paths, longest prefix wins (`src/hosts/server.ts:459`, `src/runtime/server.ts:124`) | files, artifacts, workspace, sharing, devices | Handler authorizes itself; `principal` may be `undefined` (stranger), owner, guest. |
| `Upgrades` | exact path → `(req, socket, head, principal, ctx)` | WebSocket upgrades other than `/chord` (`src/hosts/server.ts`) | terminals `/terminal` (`plugins/terminals/server.ts:22`) | Only authenticated principals reach it. |
| `Authenticators` | name → `(req, origin, ctx) => principal` | every request; first owner wins, else first principal (`src/hosts/server.ts:343-355`) | devices (owner cookie), sharing (guest cookie) | |
| `RequestResolvers` | name → `(req, ctx) => {principal, origin}` | before Host checks (`src/hosts/server.ts:357`) | radius, devices | Trusted transports only. |
| `SessionAccess` | name → `(principal, session, ctx) => boolean` | `mayReach`: worker routes, files (`src/runtime/server.ts:158-165`) | sharing (`plugins/sharing/server.ts:332`) | Any yes admits a non-owner. |
| `WorkerInitValues` | key → `(session, ctx) => value` | before each worker spawn; a throw refuses it (`src/runtime/server.ts:297-303`) | sessions (`plugins/sessions/server.ts:103`, key `session`) | Worker reads `WorkerProcess.init.values[key]`. |
| `SessionArchived` | name → `(session, ctx) => Promise` | awaited before `archive` returns (`plugins/sessions/server.ts:69`) | ports (`plugins/ports/server.ts:42`) | Defined by the sessions plugin. No restore/delete/create counterparts. |

```ts
// plugins/sharing/server.ts:326
self.register(Authenticators, {
	guest: async (request, origin, ctx) => {
		const cookie = cookieValue(request, cookieName(origin.port));
		return cookie === undefined ? undefined : ((await shares.authenticate({ cookie }, ctx)) ?? undefined);
	},
});
```

Reserved host endpoints are `/health`, `/__p2_dev`, `/__p2_tui[/<hash>.mjs]` and the `/chord` WebSocket upgrade
(`src/hosts/server.ts`). Plugin `Routes` run before the web host, so they can shadow app pages, `/__p2_web[/…]` and
`public/` files.

### 2.3 Dev, logs, notices

- **Logs:** `processLogs` (`src/runtime/logs.ts:196`) is a process global: `append(source, level, text)`,
  `notice(source, message)` (error-level owner notice, one per source, `:157-164`), `redactor.addSecret/addDirectory`
  (models, login, radius use it), `persistLogSource`/`capturePublishedLogs` for detached processes (terminals).
  Worker stderr lines starting `p2 worker:` become notices (`src/runtime/server.ts:335-343`).
- **Notices:** surfaced by the logs plugin's owner-only `LogNotices` (`plugins/logs/contract.ts:24`), rendered by the
  core web lane (`src/web/OwnerNotices.tsx:30-31`) and the logs TUI facet. There is no tone, action or dismiss API for
  plugins: only `processLogs.notice` (errors).
- **Dev:** no registry. The dev channel is host code (`src/hosts/dev-channel.ts`); the dev-tools worker plugin
  imports it directly (`plugins/dev-tools/worker.ts:5`). There is no "after reload" hook: resources with a `version` and
  Chord's per-cell migrations carry state across reloads.

## 3. Worker facets

### 3.1 Durable extensions (`Extensions`)

`Extensions` (`src/runtime/worker.ts:57`): key = extension name, value = a Durable `Extension`
(`packages/durable/src/harness/types.ts:365-374`). Every conversation selects every installed extension unless its
`pi.agent.extensions` says otherwise (`packages/durable/src/harness/types.ts:530-532`); the Harness reads the registry
through `durableRegistry` (`src/runtime/durable.ts:41`).

| Part | Field | What | p2 users |
| --- | --- | --- | --- |
| Tools | `tools` (`defineTool`, `types.ts:293`) | `parameters`, `execute(args, api, ctx)` returning `output`/`structuredOutput`/`details`; `replay: "safe" \| "unsafe"` (rerun after a crash, `:298`); `callers: ["model" \| "tools"]` (`:317`); `structuredOutputSchema` (`:311`); `deferred` (`:322`); `executionMode`, `prepareArguments`, `outputLimits`; `api.executeTool` for nested calls (`:281`) | coding-tools, artifacts, send-file, ports, conversations, sessions, subagents, dev-tools, codemode, powershell; `agent` is `callers: ["tools"]`, replay-safe with a schema (`plugins/agent/tool.ts:53-57`) |
| Prompt | `sections` (`section(key, render, {tag})`, `types.ts:349`) | rendered before each request, in extension order | prompt (`plugins/prompt/worker.ts:185-191`), coding-tools, ports, conversations, dev-tools |
| Hooks | `hooks: [hook(Task, handlers)]` | `GenerationTask`: `beforeRequest`, `afterResponse`, `onYield`, `afterTools` (`types.ts:757`); `ToolTask`: `beforeTool`, `afterTool` (`:778`); `CompactionTask`: `beforeCompact` (`:795`); handlers get `HookApi` (doc reads, memos, models, `:745`) | none yet |
| Wraps | `wraps: [wrapTool(tool, fn) \| wrapSection(section, fn)]` (`types.ts:360`) | replace another extension's tool or section where selected | none yet |
| Tasks | `tasks: [defineTask(…)]` | durable background work, resolved by name | subagents (`Anchor`, `Reporter`, `plugins/subagents/tools.ts:72,118,473`) |

```ts
// plugins/ports/worker.ts: the tool calls the server's Ports object from outside Chord through host.root
const extension = createPortsExtension(
	(query, origin, context) =>
		host.root((ctx) => ctx.get(Ports, {}).query({ conversation: 1, origin, query }, ctx), {
			signal: context.abortSignal,
		}),
	host.name.slice("session:".length),
);
contribute(host, "p2.port-tools", (self) => self.register(Extensions, { [extension.name]: extension }));
```

Who: tools run for whoever's input started the turn. Durable knows no principal; a tool declares what it needs
(`P2Tool`: `origin: "owner"`, `scope: "main"`) and the worker's registry checks it before each call (`guardTool`,
`originOf` over the run's inputs; see p2-notes **Tool requirements**). Reload: a running phase keeps its snapshot; tool code
that must survive reload reads live resources through getters (`plugins/codemode/worker.ts:37-43`).

### 3.2 Worker registries and locals

| Hook | Kind | What | Consulted | Used by |
| --- | --- | --- | --- | --- |
| `ExtensionSwitches` | registry: extension name → `Readable<boolean>` | `false` leaves that extension out of new snapshots | `src/runtime/durable.ts:31,43-93` | codemode (`codemode` setting), powershell (Windows), dev-tools (dev checkout) |
| `InputGates` | registry: name → `(ctx) => Promise` | awaited before any input is submitted | `plugins/chat/worker.ts:320,380,404`, `plugins/conversations/worker.ts:132` | prompt (first AGENTS.md load) |
| `SendRouters` | registry (chat): name → `(RoutedSend, ctx) => {submissionId} \| undefined` | `Chat.send` asks each; untaken sends become `p2.input` | `plugins/chat/worker.ts:571` | chat-mode (`plugins/chat-mode/worker.ts:134`) |
| `ReadOnlyConversations` | registry: name → `(conversation, ctx) => reason?` | refuses `Chat.send`/`dequeue`/`configure` | `plugins/chat/worker.ts:514` | subagents (one-shot agents) |
| `ConversationConfigured` | registry: name → `(conversation, ctx)` | after a browser/TUI `configure` | `plugins/chat/worker.ts:482` | subagents |
| `HarnessConfig` | registry, key `"default"` only | models + Durable settings | `src/runtime/worker.ts:332-350,410` | models |
| `HarnessEnvironments` | registry, key `"remote"` only | opens a remote machine (`at(cwd)` environments, one connection) per environment name | `src/runtime/worker.ts` | envs |
| `ConversationLocations` | local, one provider | conversations following the session, own locations (`place`, `own`) | `src/runtime/worker.ts` | subagents (`plugins/subagents/worker.ts`) |
| `Harness` | local, lifetime "host" | `harness` (native Durable Harness), `environments` (`session`, `locate(id)`, `at(location)`) | `src/runtime/worker.ts` | most worker plugins |
| `WorkerProcess` | local, lifetime "host" | `init` (dataDir, generation, `values` from `WorkerInitValues`), `liveness` (`add("viewers" \| "activeCalls")`, `stopping`) | `src/runtime/worker.ts:165` | chat and workspace (viewers), codemode (`stopping`) |
| `Conversation` | local (chat) | `submit` (input with own `entry` kind), `write` (display-only entry), `stop`, `history`, `compact`, `reset`, `runShell`… | `plugins/chat/contract.ts:140-189` | chat-mode, conversations |

```ts
// plugins/chat-mode/worker.ts:134 (shortened)
self.register(SendRouters, {
	"chat-mode": async ({ conversation, author, text, requestId }, ctx) => {
		if (!(await enabled(conversation, ctx))) return undefined; // leave it to the next router / p2.input
		const chat = ctx.get(Conversation, { conversation });
		return chat.write({ kind: CHAT_ENTRY, data: { author, text, attachments: [] }, requestId, author }, ctx);
	},
});
```

### 3.3 Entries, documents, environments

- **Entry kinds:** `Conversation.submit({ …, entry: { kind, data } })` places an input under a plugin kind
  (`plugins/chat/contract.ts:127-128`); `write` appends display-only entries (`:150-158`). Data that is a person's
  message (`MessageDataSchema`, `src/runtime/input.ts:144`) is shown by both UIs; other model-less kinds are hidden on
  the web (`src/web/transcript.ts:506-512`) and need a `TuiEntryRenderers` entry in the TUI.
- **Documents:** `defineDoc` from `@earendil-works/pi-durable`; write in `harness.commit(tx => tx.doc(Doc, id))`,
  read with `harness.snapshot(Doc, id)` or in tools/hooks via their API. Conversation docs reach clients in
  `Chat.view.docs`. Examples: `p2.subagents`, `p2.agent-run`, `p2.artifacts`, chat-mode's `ChatModeDoc`
  (`plugins/chat-mode/worker.ts:25`). Change signals: `CommitSignal` (`src/runtime/commits.ts:4`), `watchSource`
  (`src/runtime/durable.ts:113`).
- **Environments:** tools use `api.env`; plugins use `Harness.environment` / `environments.at(cwd)`. Only one remote
  provider (`HarnessEnvironments["remote"]`).

## 4. Web facets

### 4.1 Slots

`Slots` (`src/runtime/web.tsx:49`): key → React component. `<Slot name>` renders one (or its children/fallback),
`<SlotList prefix>` renders every `prefix:*` key. Every rendering site today:

| Slot | Rendered at | Kind | Filled by |
| --- | --- | --- | --- |
| `app` | `src/hosts/web/main.tsx` (`startWeb`) | single | web-shell |
| `sidebar` | `src/web/AppLayout.tsx:21` | single | sessions |
| `main` | `src/web/AppLayout.tsx:60` | single | chat |
| `workspace-panel` | `src/web/AppLayout.tsx:62` | single | workspace |
| `artifact-actions`, `terminal-actions`, `workspace-actions`, `session-options`, `session-actions` | chat top bar, `plugins/chat/web.tsx:327-331` | single each | artifacts, terminals, workspace, sessions, sharing |
| `composer:*` | `plugins/chat/web.tsx:925` (`SlotList`) | list | chat-mode |
| `chat-bottom` | `plugins/chat/web.tsx:934` | single | terminals |
| `chat-content` | `plugins/chat/web.tsx:1133` | wrapper (gets `children`) | artifacts (viewer contexts) |
| `chat-attribution` | `plugins/chat/web.tsx:1134` | wrapper | conversations |
| `sidebar-foot:providers\|envs\|devices\|ports\|logs` | `plugins/sessions/web.tsx:29-37` | five fixed `Slot`s, not a list | login, envs, devices, ports, logs |
| `envs-actions:*` | `plugins/envs/EnvsPanel.tsx:524` (`SlotList`) | list | ports |
| `workspace-terminal` | `src/web/Workspace.tsx:730` | single | terminals |
| `chat-parent` | **nowhere** | — | subagents registers it (`plugins/subagents/web.tsx:22`) |

### 4.2 Sheets, navigation, hooks

| API | Pointer | Use |
| --- | --- | --- |
| `openLayer({kind: "sheet" \| "viewer", name, locator?}, {fromDrawer?})`, `closeLayers()` | `src/runtime/web.tsx:296,302` | push a named modal; Back and reload restore it |
| `useSheet(name, kind?)` | `:316` | the top layer if it is yours, with its locator |
| `<Sheet title onClose>` | `:91` | shared modal (portal, Escape, scroll memory) |
| `useNavigation()`, `useRoute()`, `navigate()` | `:275-293`, `src/web/navigation.ts` | push/replace/close; never browser history |
| `useObject`, `useReadable`, `useStatus` | `:139,183,195` | hold objects, read state |
| `useOwner()` | `:325` | owner check (UI only) |
| `useConnected()`, `useShareEnded()` | `:225,247` | connection, ended guest share |
| `useHost()`, `useRegistry()` | `:42,52` | raw host and registry tables |

Pattern: the plugin's slot component renders its button and, when `useSheet(name)` matches, its sheet
(`plugins/envs/web.tsx:6-21`).

### 4.3 Composer, transcript, notices, theme

- **Composer:** `ComposerExpanders` (`src/runtime/composer.ts:7`): `(host, session, text) => text?`, asked in key order
  for text starting with `/` (`plugins/chat/web.tsx:621`); prompt registers one (`plugins/prompt/composer.ts:10`).
  Chips: `composer:*` slots. Shared state: `useComposerState()` (`src/web/composer-state.tsx:123`: draft, files,
  `addFiles`, `replyTo`, `canReply`/`setCanReply`, `pinChat`). `@`/Tab completion is core (`src/web/file-completion.tsx`).
  No web commands, slash commands or key bindings.
- **Transcript:** `TranscriptEntries` (`plugins/chat/contract.ts:270`): entry kind → pure `(data) => {replyTo?, note?}`,
  adds to a person's message (chat-mode, shared with the TUI). Tool cards are a fixed `switch (tool.name)` in
  `src/web/Chat.tsx:303-511` (bash, codemode, read, write, subagent, artifact, ports, send_file, edit, generic). React
  contexts the chat plugin provides to cards (`src/web/Chat.tsx:65-77`: `OpenConversation`, `OneShotAgents`,
  `OpenPeerConversation`, `WorkingDirectory`, `OpenWorkspaceFile`, `SessionId`, `ReplyTo`) are not a plugin API.
- **Owner notices:** one core lane (`src/web/OwnerNotices.tsx`) fed by `LogNotices` and the dev status; plugins can only
  publish server errors (2.3).
- **Theme:** `src/web/theme.ts` (system/light/dark, `setTheme`/`subscribeTheme`) and CSS in `src/web/style.css`; plugins
  import their own CSS (`plugins/chat-mode/style.css`). No theme contribution.

## 5. TUI facets

### 5.1 Slots and surfaces

`TuiSlots` (`src/runtime/tui.ts:50`): key → `(runtime) => TuiSurface` (`:32-45`: `render`, `dispose`, `focus`,
`contexts()`, `layout()`, `saveState()`). `tuiFacet(name, factory, commands)` (`:52`) registers one slot plus commands.
Every factory is instantiated when registered (`:480`), rendered or not.

| Key | Rendered | Filled by |
| --- | --- | --- |
| a name without `:` (except `header`, `footer`, `status`) | as a screen; also a mutually exclusive `when` term (`:397-401`); `ctx.navigate(name)` | `sessions`, `chat` |
| `header` | replaces the built-in header (`:254`) | — |
| `footer` | replaces the built-in footer (`:497`) | status |
| `footer:*` | first one only, inside status's footer (`plugins/status/tui.ts:153`) | workspace `footer:branch` |
| `composer:*` | chips under the editor, key order (`plugins/chat/tui.ts:78`) | chat-mode |
| anything else with `:` (`service:*`, `widget-above:*`) | never rendered: used as per-runtime background holders | logs, models, prompt, sharing |

### 5.2 Commands, keys, slash

`TuiCommands` (`src/runtime/tui-commands.ts:29-49`): key = command id (pi ids such as `app.model.select` where the
meaning matches, else `<plugin>.<verb>`; `tui.*` and launcher ids are refused, `:260`). Value: `title`, `category`,
`keys`, `when`, `slash: {name, argumentHint, complete, tabOnly}`, `palette`, `run(ctx, args)`.

- `when` grammar (`:65-113`): `&&`, `||`, `!`, parentheses over terms: screen names, `owner`/`guest`, `connected`,
  `overlay`, `overlay:<id>`, and the active surface's `contexts()` (`src/runtime/tui.ts:403-411`). More terms win.
- Key conflicts, launcher-owned keys, slash collisions are reported in `/hotkeys`, never thrown (`:248-330`).
- Visitors rebind ids in pi's `keybindings.json` or `prefs.json`; server defaults in `tui.json`.

```ts
// plugins/artifacts/tui.ts:192
"p2.artifacts": { title: "Artifacts", category: "Session", when: "chat && !overlay",
	slash: { name: "artifacts" }, run: (ctx) => openArtifacts(ctx) },
```

`TuiSlashSources` (`:57-62`): slash names that are not commands (`entries(ctx)`, `expand(ctx, text)`); commands win.
Prompt registers templates and skills (`plugins/prompt/tui.ts:87`).

### 5.3 Renderers

| Registry | Key → value | Order | Users |
| --- | --- | --- | --- |
| `TuiToolRenderers` | tool name → pi `ToolRenderers` (`renderCall`, `renderResult`, `renderShell`; `src/tui/tools/types.ts:15-62`) | overrides built-ins | artifacts, ports, send-file, subagents |
| `TuiToolRendererResolvers` | `<order>:<plugin>` → `(toolName, next) => renderers` | key order, then the registry, then built-ins (`src/tui/tools/index.ts:20-28`) | quiet-tools (`10:`: one line per call, full content when expanded or failed) |
| `TuiSettingFields` | `<plugin>.<name>` → `/settings` row (label, values, fallback), stored at `settings.plugins.<plugin>.<name>` of the visitor's prefs; read with `pluginSetting`; resolvers get the settings, a change redraws every card (`src/runtime/tui-preferences.ts`) | after the built-in rows, key order | quiet-tools |
| `TuiEntryRenderers` | entry kind → `(entry, ctx) => Component \| undefined` (replaces the display; `undefined` hides) | — | core `p2.shell` (`src/tui/core-commands.ts:290`) |
| `TuiMarkdownTransformers` | `<order>:<plugin>` → pi `MarkdownTransformer` | key order | core `00:mermaid` |
| `TranscriptEntries` | shared with web (4.3) | — | chat-mode |

All in `src/runtime/tui-renderers.ts:16-45`; consumed by the chat surface (`plugins/chat/tui.ts:226-248`).

### 5.4 Sessions, overlays, status, footer

- `TuiSessionSources` (`src/runtime/tui-sessions.ts:22`): `children(runtime, onChange)` and `search(runtime, query,
  archived)` for the session picker (subagents, search). `TuiSessionPlaces` (`:34`): `where(ctx)`, `moveTo(ctx, env)`
  (sessions; used by envs).
- Overlays: `ctx.overlay(id, component, options)` (`src/runtime/tui-context.ts:112`); overlay-scoped commands run
  first; closed on navigation, reload and command-table changes.
- Status lines: `ctx.notify(message, kind)` (`:107`), last three, cleared on navigation (`src/runtime/tui.ts:258-264`).
- Footer: replace it (`footer`) or add one `footer:*` line part; no ordered footer items.
- Other `TuiContext` members (`src/runtime/tui-context.ts:91-126`): `host`, `theme`, `keys`, `hints`, `settings`,
  `role`, `identity`, `navigate`, `view` (expanded tools, thinking), `commands` (run, runSlash, palette, list, report),
  `surface(name)`, `exit`, `reload`, `prefs` (theme names, preview, `save` via grant). Plugins also reach into the chat
  surface: `ctx.surface("chat") instanceof ChatSurface` (`plugins/send-file/tui.ts:93`, `plugins/chat-mode/tui.ts:70`).
- Theme: per runtime, the visitor's (`ctx.theme.current`); plugins cannot add themes.

### 5.5 Launcher grants

`ctx.grant(action, payload)` asks the visitor's launcher (`src/hosts/tui-actions.ts:376-700`). Only `C` and `gesture`
actions can be requested; `K` actions fire on the visitor's own key and may ask the worker for data through
`runtime.launcherAnswers` (`src/runtime/tui.ts:197`, `plugins/chat/tui-commands.ts:139`). Anything else is denied
(`src/hosts/tui-client.ts:226-259`).

| Action | Kind | Payload | Owner only |
| --- | --- | --- | --- |
| `attach` | C | `{path?}` → uploaded file | no |
| `copy` | C | `{text, label?}` | no |
| `openUrl` | C | `{kind: "external", url}` (https) or `{kind: "origin", path}` | no |
| `download` | C | `{kind: "file" \| "artifact", session, …}` | no |
| `savePrefs` | C | `{patch}` for `prefs.json` | no |
| `devCommand` | C | `{action: "reload"}` | yes |
| `signOut` | C | `{all}` | yes |
| `copy.selection` | gesture | selection text after the launcher saw the mouse release | no |
| `attach.key`, `paste.key`, `copy.key`, `editor.external`, `suspend` | K | — (visitor's key) | no |

## 6. Inconsistencies

1. **Tool cards.** TUI: `TuiToolRenderers` + ordered resolvers, pi's contract. Web: a hard-coded switch in core
   (`src/web/Chat.tsx:303-511`) that knows plugin tools (artifact, ports, send_file, subagent) and imports a plugin
   contract (`src/web/Chat.tsx:12`). A new plugin's tool gets the generic JSON card on the web.
2. **Entry display.** TUI `TuiEntryRenderers` replaces an entry's display; web has only `TranscriptEntries` (adds a
   reply quote and a note to a person's message) and silently drops other model-less kinds
   (`src/web/transcript.ts:506-512`). Core reads plugin documents (`view.docs["p2.artifacts"]`,
   `src/web/transcript.ts:371`).
3. **Commands.** TUI has one registry for keys, palette, slash and help with a `when` grammar. Web has none: no
   slash commands (only `ComposerExpanders` for `/template`), no palette, no shortcuts. The same action (compact,
   model, artifacts, share) is a `TuiCommand` in the TUI and a hand-placed button in the web.
4. **Same job, two registries.** Prompt expansion is `ComposerExpanders` (web, `(host, session, text)`) and
   `TuiSlashSources` (TUI, `(ctx, text)` plus `entries`); the prompt plugin registers both. Composer chips are `Slots`
   `composer:*` (registration order) and `TuiSlots` `composer:*` (key order).
5. **Naming.** TUI registries are `Tui*`; web ones are unprefixed (`Slots`, `ComposerExpanders`); `TranscriptEntries`
   lives in the chat plugin but is used by both UIs; worker `SendRouters` lives in chat, `ReadOnlyConversations`
   in the runtime, `SessionArchived` in sessions. Ordered registries are marked only by convention in key strings.
6. **Slot lists that are not lists.** `sidebar-foot:*` is five fixed names (`plugins/sessions/web.tsx:29-37`): a
   new plugin's `sidebar-foot:foo` never renders. `footer:*` in the TUI renders only the first entry. `chat-parent`
   is registered and rendered nowhere. Wrapper slots (`chat-content`, `chat-attribution`) admit one plugin each.
7. **Slots as lifecycle.** TUI plugins register invisible `service:*` / `widget-above:*` slots to get a per-runtime
   object, then find it with `ctx.surface(name)` (`plugins/prompt/tui.ts:74-80`, `plugins/models/tui.ts:116-118`).
   The designed `widget-above`/`widget-below` rendering (`docs/p2-tui-port.md` §7.2) does not exist.
8. **The chat surface as API.** TUI plugins import `ChatSurface` and call its methods (`toolViews`, `setCanReply`);
   web plugins use `useComposerState()` from `src/web`. Neither is a declared contract.
9. **Core knows plugins.** `Route` has `workspace`/`terminal`
   fields (`src/web/navigation.ts:20-23`); `OwnerNotices` imports the logs contract (`src/web/OwnerNotices.tsx:3`);
   the server reports `hasLogs: plugins.includes("logs")` (`src/hosts/server.ts:424`); `settings.json` has a closed
   schema with plugin keys such as `codemode` (`src/runtime/settings.ts:63-68`); `src/web/Workspace.tsx` is the
   workspace plugin's UI in core.
10. **Built-ins use internals.** dev-tools imports `src/hosts/dev-channel.ts`; devices imports `src/hosts/principals.ts`;
   sessions and status drive `HostLifecycle.manager` (opaque `SessionHosts`); models, login and radius call the process-global
   `processLogs.redactor`. Single-key registries (`HarnessConfig["default"]`, `HarnessEnvironments["remote"]`) and
   the single-provider `ConversationLocations` mean only one plugin can ever provide models, remote environments or
   conversation locations.
11. **Notices.** Owner notices are server errors only (`processLogs.notice`), shown by core web code and by the logs
   TUI facet; TUI `ctx.notify` is local; the web has no local notification API for plugins.
12. **Reload.** Server/worker reload in place; TUI swaps the worker; web facets take effect through a page reload.
   Registries behave the same, their consumers do not.

## 7. What is lacking (compared with pi 1.0 extensions)

Reference: `packages/coding-agent/docs/extensions.md`.

| pi 1.0 | p2 today | Gap |
| --- | --- | --- |
| `pi.on()` lifecycle: `session_start`/`shutdown`, `before_agent_start`, `context`, `message_end`, `tool_call`/`tool_result`, `turn_end`, `agent_before_settle`, `session_before_compact`, `user_bash`, `input`, `provider_stream_event`, `cache_warming_decision` | Chord resources for start/shutdown; Durable hooks cover `context` (`beforeRequest`), `message_end` (notify-only `afterResponse`), `tool_call`/`tool_result`, `turn_end` (`afterTools`), settle (`onYield`), compaction; `SendRouters` covers `Chat.send` input only | No input hook for peer/subagent/agent inputs; no `user_bash` (shell is hard-coded in chat); no stream events; no whole-prompt override (sections and `wrapSection` instead). No plugin uses hooks yet, so they are untested in p2. |
| `registerTool` with `exposure`, `namespace`, `annotations`, `prepareLoadout`, `reachesTools` | `callers`, `deferred`, replay policy | No annotations (no approval policy), no namespaces; `tool_search` not installed. |
| `registerCommand`, `registerShortcut` | TUI only | No web commands or shortcuts. |
| `registerFlag` | none | Plugins get configuration only via env vars or their own files; `settings.json` is closed. |
| `registerProvider`, `registerVirtualModel` | `models.json` and `HarnessConfig["default"]` owned by the models plugin | No provider or virtual-model contribution. |
| `registerMcpServer` | none (open item in `docs/handoff.md`) | No MCP. |
| `sendUserMessage`, `sendMessage`, `appendEntry` | `Conversation.submit` / `write` (worker), `Chat.send` (clients) | Equivalent. |
| `setActiveTools`, model and thinking control | `configure` on Durable `pi.agent`; `ExtensionSwitches` | Equivalent, per conversation. |
| `registerToolRenderer`, message renderers | TUI only | Web has neither (6.1, 6.2). |
| `ctx.ui` dialogs (`confirm`, `select`, `input`), widgets, status, title | TUI overlays and status lines inside the TUI; nothing a tool can ask | A tool cannot ask the person (ports asks the model to obtain confirmation in chat). |
| `pi.events` between extensions | Chord contracts and registries | Stronger in p2. |
| packages with skills, prompts, themes | built-in plugins only | Designed in `plugin-loading.md`. |
| themes | TUI: visitor's own; web: fixed CSS | No plugin themes. |

## 8. Proposals

Ordered by value; each keeps one name and one shape across surfaces.

1. **Tool and entry renderers on the web.** Add `WebToolRenderers` (tool name → `{ card(tool, ctx) }`) and
   `WebToolRendererResolvers` (`<order>:<plugin>`, `next()`), mirroring the TUI pair, and `WebEntryRenderers`
   (entry kind → component). Move each case of `src/web/Chat.tsx:303-511` into its plugin (coding-tools: bash, read,
   write, edit; codemode; subagents; artifacts; ports; send-file). Pass today's React contexts as one documented
   `CardContext`. Core then reads no plugin documents or contracts.
2. **One command model.** Move the command shape (`id`, `title`, `category`, `when`, `slash`, `keys`) to a
   surface-neutral module with `run(ctx)` where `ctx` has the shared part (host, identity, role, navigate, notify),
   and keep `TuiCommands` plus a new `WebCommands` that share ids (`app.session.compact` on both). The web gets slash
   commands in the composer, a palette and shortcuts from the same entries.
3. **One slash source.** Replace `ComposerExpanders` and `TuiSlashSources` with `SlashSources`
   (`entries(identity)`, `expand(identity, text)`) used by both composers.
4. **Consistent naming and order.** Prefix per surface (`WebSlots`, `WebComposerExpanders` → or shared names when
   shared); give registries an explicit `ordered: true` option (or an `order` field in values) instead of key
   conventions; make `SlotList` key-ordered like the TUI. Move shared registries (`TranscriptEntries`) to
   `src/runtime` or a neutral contract module.
5. **Real lists.** `sidebar-foot:*` and TUI `footer:*` as ordered lists; delete or render `chat-parent`; make
   wrapper slots chains (`chat-content:*`).
6. **A TUI service registry.** `TuiServices` (`name → (runtime) => { dispose() }`) for per-runtime holders, and
   render `widget-above:*`/`widget-below:*` as designed; replace `ctx.surface("chat") instanceof ChatSurface` with a
   `ctx.chat` interface (editor text, tool views, replies) and expose the same on the web instead of
   `useComposerState()` internals.
7. **Owner notices as a contract.** A server `Notices` registry/object (tone, message, actions as command ids,
   dismiss) with web lane and TUI status lines as two renderers; `processLogs.notice` becomes one producer.
8. **Plugin settings.** `settings.json` `plugins.<name>` validated by a schema each plugin registers
   (`SettingsSchemas`), hot-reloaded like today; moves `codemode` out of core. This also covers pi's flags.
9. **Multi-provider registries.** `HarnessConfig` → `ModelProviders` (several plugins add providers, merged into
   `Models`); `HarnessEnvironments` keyed by environment kind; `ConversationLocations` as a registry. Unblocks
   `registerProvider`-like plugins and MCP.
10. **Hooks that p2 owns.** An input hook for every submission path (Chat, peer, subagent, agent), a shell hook for
   `Chat.shell`, and a worker-side `ToolApprovals` question document with web and TUI renderers, so a tool can ask a
   person (pi's `ctx.ui.confirm`) and annotations can drive it.
11. **Core free of plugin names.** Web facets loaded from the plugin graph like the other surfaces (plugin-loading.md);
   `Route` extension data per plugin (`route.plugins[name]`); no `plugins.includes(...)` in hosts; dev-tools through a
   `DevControl` contract instead of `src/hosts/dev-channel.ts`.
