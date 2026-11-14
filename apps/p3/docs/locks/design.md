# p3 locks: what a Pi, an app and a session may use (design, PROPOSED)

Status: the owner's decisions of 2026-11-13, written down for review. Not built. Companion to Chord's admission
(`packages/chord/docs/admission/design.md`): admissions decide **who** may reach an object; locks decide **what** a
Pi, an app or a session gets (tools, skills, MCP servers, places, plugins). Supersedes the settings layer of
`apps/p3/docs/org-managed/book.md` and the lock chapters of `apps/p3/docs/people/book.md` (second edition).

## 1. The model

- **A plugin declares what can be switched off or limited** (a lock), registers it with the server, and enforces it
  itself where it hands things out. The base stores values and composes them; it enforces nothing on its own except
  the plugin switch (section 5).
- **Layers, only narrowing:** company (the org profile) > Pi (the owner) > app (the app's defaults in code, then the
  owner's app configuration) > session (the owner, the app's code, or the agent from the owner's sessions).
- **One sheet per scope** (Pi, app, session; the company's in Radius), for technical owners, with the agent's help.
- **Everything user-visible is a message** (Chord's `defineMessages`, `MessageData`), never a string.

## 2. Declaring a lock

```ts
// @p3/v1 (shared), PROPOSED
export type Lock<T extends JsonValue> = {
	readonly id: string;                                  // "coding.bash"; names as Chord's ([a-z0-9@/._~-])
	readonly title: MessageData;                          // rendered per viewer (Chord §23 "Messages and languages")
	readonly description?: MessageData;
	readonly version: number;
	readonly schema: Schema<T>;                           // pi-schema; values are checked against it on every write
	readonly open: T;                                     // no restriction
	readonly closed: T;                                   // the most restrictive value
	narrow(upper: T, lower: T): T;                        // a lower layer only narrows
	migrate?(old: JsonValue, from: number): T;            // pure, for stored values of older versions
};
export function defineLock<T extends JsonValue>(id: string, shape: Omit<Lock<T>, "id">): Lock<T>;
// Built-in shapes (each a defineLock with fixed open, closed, narrow):
export function switchLock(id: string, text: LockText): Lock<boolean>;                         // open true; narrow a && b
export function allowDenyLock(id: string, text: LockText): Lock<{ allow: string[] | null; deny: string[] }>;   // globs
export function maximumLock(id: string, text: LockText, limit: number): Lock<number>;          // narrow Math.min
```

```ts
// plugins/coding-tools/contract.ts
export const BashLock = switchLock("coding.bash", { title: messages.message("bashLock"), description: messages.message("bashLockAbout") });
// plugins/coding-tools/server.ts: registered with the server (a facet contribution; known with no worker running)
self.contribute(Locks, [BashLock]);
```

`Locks` is a server registry the locks plugin defines (`defineRegistry<readonly Lock<JsonValue>[], LockTable>`,
composed with `keyedEntries` by id; a duplicate id is reported, the first by plugin name wins). Locks are declared
statically (in a facet): what exists only at runtime (servers, tools, skills) is a **value** of a static lock, never a
new lock.

## 3. Reading a lock's value

```ts
// plugins/locks (worker), PROPOSED: this session's effective value, live
export function lockValue<T extends JsonValue>(self: Self, lock: Lock<T>): Readable<T>;
// how it works: `self.get(SessionLocks, {})` (a remote object on the server, worker variant: its principal names the
// session) has one state member `values: map(unknown())` (effective values by lock id, all layers narrowed and
// migrated on the server); lockValue = self.derive([values], ([v]) => (Object.hasOwn(v, lock.id) ? v[lock.id] : lock.open))
// cast to T after the server's check. Read in openers, derives, routines and methods, never in a factory (§6).

// plugins/locks (server), PROPOSED: any session's effective value, for server objects
export function lockValueFor<T extends JsonValue>(self: Self, lock: Lock<T>, session: string): Readable<T>;
// self.get(LocksStore, {}).effective.at(session) (a keyed member of the locks plugin's local store), then the same derive.
```

The locks plugin's server store keeps the stored values per scope (a document per scope, keyed: `pi`, `app:<id>`,
`session:<id>` host-keyed by `Session`) and computes each session's effective values: for every registered lock,
`narrow(company, narrow(pi, narrow(app, session)))`, each layer's value migrated to the lock's version first (a value
of a newer version, a failing `migrate` or a value failing the schema gives `closed` and is reported). The app layer
is the app's code defaults (`AppContribution.locks`) overridden by the owner's app configuration.

## 4. Enforcing: the plugin does it where it hands things out

```ts
// plugins/coding-tools/worker.ts: bash is not in the extension while the lock is off
host.serve(CodingTools, (_params, self) => {
	const bash = lockValue(self, BashLock);
	const extension = self.writable(codingExtension({ bash: false }));          // closed until the value is known
	self.on(bash, ({ value }) => extension.set(codingExtension({ bash: value })));
	self.contribute(HarnessExtensions, extension);
	return {};
});
```

The locks decided so far:

| Lock | Plugin | Value | Enforced where |
| --- | --- | --- | --- |
| `harness.tools` | harness (base) | allow/deny globs over tool names | composing every session's tools |
| `coding.bash` | coding-tools | switch | the extension and the tool's execute |
| `conversations.reach` | conversations | list of session ids or null | listing and sending (a session's agent reaches other sessions only through it) |
| `terminals.use` | terminals | switch | `Terminals.open` (pane and agent tool) |
| `mcp.servers`, `mcp.tools`, `mcp.project` | mcp | names (`project:<name>` for `.pi/mcp.json`), globs, switch | placement, the worker's extension |
| `prompt.instructions`, `prompt.skills`, `prompt.context` | prompt | sources; allow/deny globs with sources (`plugin:<p>/<s>`, `env:<e>/<s>`, `project:<s>`) | loading, listing, `/name` expansion |
| `locations.places` | locations | `{ environment, cwd }[]` or null | every move and every spawn with `cwd`/`env` |
| `subagents.use`, `subagents.environments` | subagents | switch, list | spawn and moves of subagents |

**When a lock takes effect** (owner, 2026-11-13): from the next composition. Durable pins a snapshot of the tools per
task phase (Chord §17), so a turn already running keeps what it had; the next turn uses the new value. Locks are no
security boundary within a turn and get no check at the call.

Subagents run in the session's worker: every session lock applies to them too. A place decides which instructions and
skills load; it is not confinement (only an environment, e.g. a sandbox, confines).

## 5. Plugins as a whole: the plugin switch

- **Base plugins** (from Pi's own root, `startServer({ root })`) have no switch; they declare locks.
- **Every other plugin** (from the user's root: installed by the owner, the agent or an org profile) gets an
  automatic switch lock `plugin:<name>` per app and session. An app sets its default for plugins it does not know:
  `defineApp(id, { otherPlugins: "on" | "off" })`; on every install the owner (or the agent) chooses the apps ("Enable
  weather in [x] Coding [ ] Robot", pre-filled from the flags). An app's own plugin is always on in its sessions.
- **Enforced by the base** in the registries it owns: the harness leaves a switched-off plugin's contributions out of
  that session's composition (extensions with tools, sections, hooks, wraps, tasks; environment and model providers);
  the page leaves its panes, slots and commands out of panes of that session (every pane carries `{ app, session }`).
  The plugin's code still runs (every worker loads every plugin); nothing reaches it through switched-off
  contributions. Owners of other registries use `pluginAllowed(self, plugin)`.
- **A company ban** is not a switch: it is the loader's admission (the kit gets `startServer({ plugins: { admit } })`;
  a blocked plugin is never loaded on that Pi; from `org-managed/book.md`).

## 6. The sheet

```ts
// plugins/locks (server), PROPOSED: the sheet's object, owner only
export const LockSheet = remote("locks.sheet", { version: 1, params: { scope: str() },   // "pi", "app:<id>", "session:<id>"
	hostAddress: () => Server(),
	variants: { owner: {
		state: { locks: arr(LockRow) },        // per registered lock: id, plugin, title, description, JSON Schema,
		                                       //   values per layer with who set them, effective value
		methods: { set: method(obj({ lock: str(), value: unknown() })), clear: method(obj({ lock: str() })) },
	} } });
```

- Controls come from the schema (a switch: a toggle; a list or globs: a list with a text field). A plugin may
  contribute its own editor (`LockEditors`, a web registry: lock id → component).
- Upper layers show read-only next to the editable value ("closed by the company").
- Values of locks no plugin declares now stay stored, shown "missing", without effect.
- **The agent:** a code-mode namespace `locks` (`locks_catalog({ scope })`, `locks_set({ scope, lock, value })`),
  served only to the owner's sessions; `locks.manage` is itself a lock (closed in robot, club, Discord).

## 7. Candidates (open)

The sheet should offer possible values: the skills of the session's location, the configured MCP servers, the
sessions for `conversations.reach`. What exists today (decided): candidates come from an object of the plugin that
owns the lock, never from a function in a contract file (it would reach no data).

```ts
// PROPOSED: a server registry of candidate sources, contributed by host-lifetime objects (closures with handles)
export type CandidateSource = (scope: LockScope, ctx: Ctx) => Promise<readonly Candidate[]>;
type Candidate = { readonly value: string; readonly title: MessageData; readonly group?: MessageData };
export const LockCandidates = defineRegistry<Readonly<Record<string, CandidateSource>>, ReadonlyMap<string, CandidateSource>>(
	"locks.candidates", { version: 1 });

// plugins/prompt/server.ts: skills as candidates; the worker reports what it found at its location
host.serve(PromptStore, (_params, self) => {
	const skills = self.registry(Skills);                       // plugins' skills, composed on the server
	const found = self.state(LocationSkills);                   // keyed by Session: reported by each session's worker
	self.contribute(LockCandidates, { [SkillsLock.id]: async (scope, ctx) => [
		...pluginSkillCandidates(skills.value),
		...(scope.kind === "session" ? locationCandidates((await found.get(Session({ id: scope.session }), ctx))?.skills ?? []) : []),
	] });
	return { /* report: method the worker calls with what it found */ };
});
```

Open: is a function registry right (a call per sheet open, nothing live), or should candidates be state the plugin
keeps (a live list per scope the sheet holds)? How does a project (not a session) get its candidates when no worker
is there (the envs plugin listing a folder on the server)? Pickers per value type (`ref(Session)`: the sessions
plugin's list) as one source per type?

## 8. Companies and Radius

- The company layer is the org profile: an initial copy on disk (the enrollment), then what Radius delivers, signed,
  cached, followed live (`org-managed/book.md`).
- The profile holds lock values by id with their version, and the plugin list (required, allowed, blocked).
- Radius learns locks from member Pis' reports: per lock id, plugin, version, JSON Schema, `open`, `closed`, the
  title and description as `MessageData` plus the plugin's catalogs for those keys (Radius renders in the admin's
  language, English as fallback). Radius renders switches, fixed lists and text; references to a member's things
  (sessions) only as `open`/`closed`. Loading plugins' server facets in a sandbox on Radius to learn locks before
  any member installed them: later, if the admin panel needs it.

## 9. Open

1. Candidates (section 7).
2. The page side of the plugin switch: how the page composes panes, slots and commands per `{ app, session }` (use
   sites filter by `pluginAllowed`; no second registry).
3. The kit change for the company ban (`plugins.admit`), and Radius reports (a Radius change).
