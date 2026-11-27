# p3's base: what every plugin builds on

What the base and the built-in plugins give every plugin, as main has it after the sessions became session workspaces
([ERNDL-704 5 · Sessions as session workspaces](https://linear.app/earendil/issue/ERNDL-704), push 3). The design is
the "Pi next" package ([ERNDL-1140](https://linear.app/earendil/issue/ERNDL-1140)) and its API
([ERNDL-1141](https://linear.app/earendil/issue/ERNDL-1141)); this file says what is built.

## Words

| Word | Means |
| --- | --- |
| **owner** | a person with the owner flag; gets every tick meant for people of everything available (decision 99) |
| **person** | anyone who signs in, the owner among them |
| **thing** | one record of a kind a plugin brings (a canvas, a notebook, a login, the coding tools, a session): one id, one name, linked in one or more workspaces |
| **kind** | a plugin's type of thing (`defineThing`): its members, its ticks, its default grants, who may make one |
| **workspace** | a thing that holds things and people (Pi, a project, Family); Pi is the root, made at the first start |
| **session** | a session workspace (`sessions.session`): a leaf (things and people, never workspaces) with one agent; its id is its workspace's |
| **tick** | a right on a thing, granted to a party where the thing is linked: a kind's own (Read, Draw, Bash) or a workspace tick (Link, Hide, Configure, Manage people, Manage access, Make) |
| **party** | whom a grant names: everyone here, the agents, a person, a group, one session's agent |
| **answer** | what a caller gets for one thing in one workspace: its ticks (perhaps none), from the things plugin's index |
| **view** | one way to look at a target (a thing of a kind, a person, a group): an entry of the things plugin's `Views` |
| **location** | where a session works: a machine (its id) and a folder on it |

## Sessions

A session is a session workspace (decision 13). It is made in a workspace with that workspace's `Workspace.make`:

```ts
const id = await workspace.make({ kind: SessionKind.name, name: "Fix the build", input: { location } }, ctx);
```

- **Making one** needs Make of sessions in the parent (`@make:sessions.session`, or `@make:*`). The maker gets every
  tick of the new session and is put in (decisions 88, 90, 115); its agent is put in too, with Make for the content
  kinds only (R6).
- **Its ticks** are the workspace ticks and the session kind's own: **Read** (the transcript), **Send** (the
  composer), **Stop**, **Manage** (archive, restore, the model). Its name is its thing's, changed with Configure in
  its parent (decision 80). The transcript is no thing (decision 76).
- **Shared or private** comes from the nearest session defaults thing (`sessions.defaults`) available in the parent
  (decisions 75, 93; one `Gives` read as the server, switches applied): shared gives everyone here Read and Send;
  private writes no grant for everyone and hides people from above. The defaults also give the new session its
  model (metadata until the model picker asks the agent's model with it) and the view it opens with. The sessions
  plugin seeds one defaults thing in Pi (shared).
- **Its row** (`SessionRow`: location, state, last touch, archived, model) is the session kind's state, for everyone
  let in: `SessionObject` held at `{ workspace: id, thing: id }`. The worker reports the state
  (`SessionFacts.report`); the waker starts the workers of `working` sessions after a restart.
- **Archiving** needs the session's Manage and is one commit of the row: the worker stops the run under way as Stop
  does (decision 122) and starts no work; the kinds keep what they keep for the session (its terminals). A restore
  resumes nothing by itself. **Unlinking** it from its parent needs Link there (decision 104); the session goes with
  its row, and the kinds are told (`workspaceGone`).
- **Lists** of sessions are the things plugin's lists of a workspace's children (`WorkspaceChildren`), filtered by
  presence. Listing starts no worker.
- **Where it works:** the make's `location`, or (left out) this device in a folder of its own,
  `<data directory>/folders/<id>`.

## Admission: one question

A plugin never reads a principal to decide who may do what. **A kind's object** is served with `serveThing` and
admitted by the things plugin's one admission: the caller's answer for the thing where it is held, its ticks granting
the members and flags they give (a member no tick gives is for everyone let in, decision 111). The kind writes only
the members:

```ts
serveThing(host, CanvasKind, {
	implement: ({ workspace, thing }, { caller, granted }, self) => ({ shapes, add, remove, clear, … }),
	create: async ({ thing, input, by, workspace }, ctx) => undefined,   // before the commit that makes it
	delete: async (thing, ctx) => { … },                                 // its content, when it goes
});
```

**A session's objects on its worker** (the session's worker object, the transcript, a plugin's own) are admitted by
`followSession(gives)`: the caller's answer on the session workspace (`MyAnswer`, live); nothing given denies, else
the caller is granted the members `gives` names for each of the session's ticks they have:

```ts
host.serve(Transcript, factory, { admit: followSession(TRANSCRIPT_GRANTS) });   // read → view, entries; send; stop
```

A view reads a grant live: `withGranted(useLive(ref), "send")` is the reference with `send`, or `undefined`.

**The route asks the same question before it starts anything** (`src/server.ts`): no worker starts for a caller the
session's workspace gives nothing; a worker never reaches another session's worker. A grant changed, a person hidden,
a session made private: the caller's object is rebuilt or denied at once (Chord's admission).

The owner's own objects use `admitOwner`: allowed while the caller has the owner flag.

## What admission confines, and what it does not (Mario, 2026-11-23)

Admission confines **people and the agent**: what they see and do in p3's objects. It does not confine two things,
and that is decided, not a gap:

- **Plugins are trusted.** Every plugin the owner installs runs in the server's and the workers' processes with their
  stores. A plugin's server code can get any server-only store contract (`ThingsStore`, `SessionsStore`, a kind's
  store), call an object as the server (which gets everything), and read `ServerRuntime.store`. No contract says which
  plugins may reach it: that would cost extensibility and still not stop code in the same process. Install only
  plugins you trust.
- **A shell on a machine is that machine's user.** An agent whose session has the coding tools with Bash, on this
  device, runs as the owner's OS user: it can read the Pi's data directory and the owner's files and logins, and reach
  p3's own command socket. That is what lets an agent write and apply plugins, and it is why everyone who may Send in
  such a session can have the agent do it too. To confine the agent, withhold Bash, or give the session a location
  without the owner's files (a sandbox such as Gondolin, another machine).

## What the agent gets

The agent is Durable's harness in the session's worker (plugin `harness`). **It gets exactly the things it holds**:
the session's worker holds a reference to each thing its workspace gives its agent, as the agent (`AgentThings` on
the server, read from the things index; the holding in `sessions/holding.ts`), and publishes them in `HeldThings`
(the things plugin's `contract.worker.ts`), each kind's list nearest last. The harness calls each kind's harness part
with them:

- **One part per kind**, for all the things of it the agent holds: `thingHarnessPart(Kind, (things, session) => ({
  extension, providers, env }))` (the extension has no name: it is installed under the kind's), contributed to
  `ThingHarnessParts`, called again whenever that kind's list changes (a thing added, let go of, granted anew, linked
  nearer), never with none. Each entry is `{ thing, workspace, depth, ref }`. Its tools take a thing's id; a list tool
  names the things (`canvas_list`), so descriptions stay fixed text. A tool is offered only while its tick is granted
  on some thing (`ref.add`, `ref.granted.has("bash")`).
- **A tool acts as the agent** through the held reference (decision 120.1); `session.call(fn, context)` runs `fn` as
  the session's worker with references of its own, released when `fn` settles, for a tool that needs one.
- **A `main` tool** (`HarnessTool`'s `scope: "main"`) works only in the session's top-level conversations (the
  `subagent` tool: no subagent starts subagents). A subagent gets the agent's tools again with every message it is
  sent: those offered to the agent then, minus the `main` ones (never one the agent has not); the harness installs
  `main` tools guarded (a call from a subagent is refused).
- **A part's environment** is a function of the conversation's location (`{ machine, folder }`), answered by the
  machine kind for the machines the agent may work on. Only parts give environments: a machine withheld or let go of
  leaves none.
- **The agent makes things** with the things plugin's own part, `make_thing` over the session workspace's `make`:
  planned, not built yet.
- Installing a plugin gives no session anything; there is no global tools registry. An agent that holds no login has
  no model.

`HeldThings` is `undefined` until the holding's first set settled (at most 4 s); the harness applies what is held
before it resumes and before every submit: work starts only through the harness (`SessionHarness.submit`). A tick
withheld or a thing let go of while a tool call runs: the next step has no tool; a call under way through the held
reference fails `unavailable` until [ERNDL-1182 Chord: a regrant lets calls under way
finish](https://linear.app/earendil/issue/ERNDL-1182). An archived session's worker opens its transcript without
scheduling any work. The session is reported `working` before Durable accepts an input, so a crash in between leaves
it for the waker.

## The page

The things plugin owns the page's frame for workspaces: the navigator (a workspace's sessions, things and people),
a target's view, the Settings view (who may do what, one checkbox per grant row), the add-thing dialog and invites.
Plugins contribute to it:

- **`Views`**: a kind's views of a thing (`{ view, title, area, for: { kind: "thing", thingKind }, View }`), and
  views of a person or a group. A kind has 0 to n; the transcript plugin gives the session kind its view.
- **`ThingParts`**: what a kind has once on the page: its icon, its create step (`Create`, which hands the make's
  input to the add dialog with `onReady`; the session kind's asks where the session works), its Settings form.
- **`PluginTitles`**: a plugin's title and icon, for the add dialog's grouping.
- **Components** are typed tokens: `defineComponent<Props>(name)` in a contract file, one `Components` contribution
  per component, `useComponent(Token)` returns it. The pane layout (`PaneLayoutView`, the `layout` plugin's) is one:
  panes in splits and tabs the person drags; on a phone one pane at a time under a strip of chips.
- **The chrome** (plugin `chrome`) is the page's root: the top bar, the person menu, the connection state.

Elanor as Inkling uses it, from npm, pinned together (`@earendil-works/elanor-react`, `design-tokens`, `elanor-fonts`,
`elanor-icons-react`): the base's stylesheet declares `@layer reset, elanor;`, Elanor's component styles from
`elanor.min.css`, plugins' CSS modules unlayered and winning; the server serves Elanor's fonts at `/fonts/elanor/` and
the `pi` brand tokens at `/tokens.css` as stable files; light and dark follow the system. React and Elanor are host
packages of the `web` kind, so a third party's plugin type-checks against the versions p3 ships; icons come from
`/v1/web` by name.

## Registries

| Registry | Host | Contributed by |
| --- | --- | --- |
| `ThingKinds` | server | each kind's plugin, through `serveThing`: the kind's data (ticks, default grants, makers, settings) |
| `ThingHooks` | server | each kind's plugin, through `serveThing`: its `create`, `configure`, `delete`, `workspaceGone` hooks and its seeded thing |
| `ThingHarnessParts` | worker | each kind's plugin: its harness part, for all the things of the kind the agent holds |
| `HeldThings` | worker | the sessions plugin's holding: the things the worker holds as the agent, by kind |
| `ExecutionEnvironments` | worker | the environments plugin: an `ExecutionEnv` for a location |
| `SessionHarness` | worker | the harness: the open Durable harness and `submit`, for the transcript and others |
| `Views`, `ThingParts`, `PluginTitles` | page | each kind's plugin |
| `Components` | page | each component's plugin (the pane layout: the layout plugin) |
| `PageRoot`, `PageConnection` | page | the chrome (the one component the base renders); the base |
| (base) `WorkerRunners`, `WorkerRunnerWraps`, `WorkerBusy`, `ServerCommands`, `LinkOpened` | | |

## Plugins

| Plugin | Owns |
| --- | --- |
| `things` | the things core: things, workspaces, grants, the access index (`Gives`, `MyAnswer`), the kinds' registries, `Workspace` and the page's lists; the page's frame for workspaces |
| `sessions` | the session kind (session workspaces), the session defaults kind, the sessions' store (where each works, its state, its model), the waker, a worker's facts, the holding |
| `sign-in` | sign-ins; the owner link |
| `people` | persons and groups; `Me`; invite links that make a person and sign them in |
| `environments` | machines; this device; `ExecutionEnvironments` |
| `harness` | Durable in the worker over the kinds' harness parts, the activity report; the subagents kind (`harness.subagents`) |
| `transcript` | a session's conversation as people see it, by the session's ticks; its view |
| `tools` | the coding tools (`tools.coding`): four flag ticks for the agents (Read, Write, Edit, Bash), one thing in Pi |
| `prompt` | instructions and skills, two kinds (`prompt.instructions`, `prompt.skills`) |
| `providers` | logins as things: the agent's model providers |
| `notes`, `canvas`, `checklist` | kinds of content: notebooks, a shared drawing board, a checklist |
| `chrome` | the page's root: the top bar |
| `layout` | the pane layout (`PaneLayoutView`): splits, tabs, dragging; chips and swipes on a phone |
| `backup`, `runner`, `control` | backups of sessions; how workers run; the `p3` command's server side |

## Examples

A kind's whole plugin, small: `plugins/checklist/` (its kind in `kind.ts`, its store, `serveThing` in `server.ts`, its
view in `checklist-view.tsx`, `Views` and `ThingParts` in `web.tsx`, its harness part in `worker.ts` where it has
tools). A kind with motion and agent tools: `plugins/canvas/`. A workspace kind: `plugins/sessions/` (`defineWorkspace`
in `contract.ts`, the create hook in `session.ts`).

## Out of the base, for later packages

- Sharing UI and guest links beyond invites: [ERNDL-717 Permissions and sharing](https://linear.app/earendil/issue/ERNDL-717),
  [ERNDL-706 Sign-in and identity](https://linear.app/earendil/issue/ERNDL-706).
- The file, diff and terminal views: [ERNDL-796 Earendil-provided views](https://linear.app/earendil/issue/ERNDL-796).
- MCP: [ERNDL-725 MCP (UX, device MCP)](https://linear.app/earendil/issue/ERNDL-725).
- A location per conversation, moved by the agent or by Manage (decision 24): carry-over of ERNDL-704.

Each plugs into the registries above without a base change.
