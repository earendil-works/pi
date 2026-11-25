# Waiting work: the host side of suspendable work (p2, p3)

Status: design draft, 2026-11-09, by the p3 session (8b6ab5cc) at the owner's request. Nothing is built or committed.
It builds on `packages/durable/docs/suspendable/spec.md` (fifth revision, cited as "S§n") and changes nothing in
Durable. It covers what S§9 leaves to hosts: how plugins' hooks are composed, the records of open waits and their UI,
webhook routing to `signal()`, and p2's liveness. Code is written against p2's real API (`@p2/app/v1`, its runtime in
`src/runtime/`); section 6 says what differs in p3.

Three concepts, nothing else:

1. **A stage on every hook** a plugin contributes: `transform`, `check`, `claim` or `observe`. The composer installs
   hooks in that order, and makes observers unable to return anything.
2. **Wait records:** one server table of open waits. A record names the session, the task, the signal token and the
   key, and who answers: a person (questions, approvals) or a service (webhooks). Every answer takes one delivery path
   to `harness.signal()`.
3. **The wake handoff:** the worker reports `harness.wake()` to the server, which keeps the next `at` durably and
   starts the worker when it is due. Liveness comes from `wake().active`, not from counting tasks.

## 1. Stages: composing hooks

### 1.1 The problem

Durable runs hooks in extension order, and the first `block` or `sleep` of `beforeTool` stops the chain (S§5.1). p2
installs extensions in plugin-name order (`keyedRegistry`, `src/runtime/durable.ts`), which is deliberately
meaningless. Three things therefore go wrong today:

- **An approval sees arguments that later change.** A `transform` plugin named `zz-paths` rewrites `ls foo*` after
  the plugin `approvals` has approved it.
- **A quota is taken while a person decides.** A plugin `quota` sorted before `approvals` reserves a slot, then
  `approvals` sleeps for an hour.
- **An observer can change things.** A stats plugin's `afterTool` that returns a value replaces the result.

### 1.2 The rule

Every hook a plugin contributes carries a stage. The composer installs all hooks in stage order, then plugin order:

| Stage | For | Guarantee |
| --- | --- | --- |
| `transform` | arguments, messages, payloads, results that change | runs first |
| `check` | approvals, permissions, quiet hours, Discord policy: decide, take nothing | sees the final arguments |
| `claim` | quotas: take a resource | runs only when every check passed in this pass |
| `observe` | stats, logs, search indexes | runs last; its return value is dropped, its throw only reported |

Nothing else is needed for merging or ordering:

- **Several checks:** the first check that sleeps stops the pass. When it wakes, Durable reruns the whole call phase
  (S§5.1): every check is asked again, so a quiet-hours check that passed at 20:00 is asked again when the approval
  arrives at 23:30. Two approvals are asked one after another, not at once. That costs latency, not correctness, and
  needs no merge rule.
- **A claim only after the checks:** a claim runs only in a pass in which no check stopped, because the checks come
  earlier in the same chain. A claim that sleeps (the quota window) is asked again with the checks at its wake.
- **Releasing a claim:** the claiming plugin contributes an `afterTool` hook in the `observe` stage. Durable runs
  `afterTool` on every result, blocked and aborted included (S§5.3), and the plugin releases there. Past the restart
  limit, and for faulted or orphaned tasks, the plugin reconciles against the task graph instead.
- **Third-party tasks:** the composer does not know a task's hooks. It orders and mutes them all the same way, by
  stage, whatever the task (section 1.5).

### 1.3 The contribution type

```ts
// src/runtime/durable.ts
import { type Extension, type HookRegistration } from "@earendil-works/pi-durable";

/** Where a hook runs among all plugins' hooks; the order of the values is the order of the stages. */
export type HookStage = "transform" | "check" | "claim" | "observe";
const STAGES: readonly HookStage[] = ["transform", "check", "claim", "observe"];

/** A hook as a plugin contributes it: Durable's registration with its stage. */
export type StagedHook = { readonly stage: HookStage; readonly hook: HookRegistration };

/** A Durable extension as p2 plugins contribute it: its hooks carry stages. */
export type P2Extension = Omit<Extension<P2Tool>, "hooks"> & { readonly hooks?: readonly StagedHook[] };

/** The worker's extensions by name (host-lifetime objects contribute them). Was `Extension<P2Tool>`. */
export const Extensions = keyedRegistry<P2Extension>("p2.durable-extensions");
```

One extension can have hooks in several stages: the approval plugin's check on `beforeTool` and nothing else, a quota
plugin's claim on `beforeTool` and its release in `observe`.

### 1.4 The composer

`durableRegistry` (`src/runtime/durable.ts`) builds Durable's registry from the table. It now installs each contributed
extension once without hooks, then one extension per (stage, extension) holding that extension's hooks of that stage:

```ts
/**
 * Installs `installed` into `builder`: every extension with its tools, sections, wraps and tasks, then its hooks by
 * stage, all transforms first, then checks, claims and observers, each stage in table order. Durable runs hooks in
 * install order (p2 never sets a conversation's `extensions`), so every hook point runs its stages in that order.
 */
function installStaged(builder: Registry<P2Tool>, installed: readonly P2Extension[]): void {
	for (const extension of installed) {
		const { hooks: _hooks, ...parts } = extension;
		builder.install(parts.tools ? { ...parts, tools: parts.tools.map(guardTool) } : parts);
	}
	for (const stage of STAGES) {
		for (const extension of installed) {
			const hooks = (extension.hooks ?? []).filter((staged) => staged.stage === stage).map((staged) => staged.hook);
			if (hooks.length === 0) continue;
			builder.install({ name: `${extension.name}#${stage}`, hooks: stage === "observe" ? hooks.map(muted) : hooks });
		}
	}
}

/**
 * `registration` with every handler's result dropped: an observer can neither replace nor block anything. Its throw
 * is reported, not rethrown (a throwing `beforeTool` would block the call, spec §7.2).
 */
function muted(registration: HookRegistration): HookRegistration {
	const handlers = Object.fromEntries(
		Object.entries(registration.handlers).map(([name, handler]) => [
			name,
			async (...args: unknown[]): Promise<undefined> => {
				try {
					// A hook handler map holds functions only (Durable's `HooksOf<K>`).
					await (handler as (...args: unknown[]) => unknown)(...args);
				} catch (error) {
					console.error(`durable: observer ${registration.task}.${name} threw:`, error);
				}
				return undefined;
			},
		]),
	);
	return { task: registration.task, handlers };
}
```

In `snapshotOf`, the loop `for (const extension of installed) builder.install(...)` becomes
`installStaged(builder, installed)`; the tool-search fallback and `ExtensionSwitches` stay as they are (a switched-off
extension is left out with all its stages). Rules the composer relies on: p2 never writes a conversation's
`AgentState.extensions` (subagents narrow `tools`, `plugins/subagents/worker.ts`), so every conversation selects every
installed extension in install order; and a `#stage` name never collides with a contributed one, since `#` is not
used in extension names.

### 1.5 Plugins using it

```ts
// plugins/approvals/worker.ts: a check on the arguments that will run
import { bool, obj } from "@earendil-works/pi-schema";
import { defineSignal, hook, ToolTask } from "@earendil-works/pi-durable";
import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions, Signals, workerOf } from "@p2/app/v1/worker";
import { Waits } from "../waits/contract.worker.ts";

export const Approval = defineSignal({ name: "approvals.decision", version: 1, schema: obj({ allow: bool() }) });
const DAY = 24 * 60 * 60 * 1000;

// The plugin's own judgment of a command, and a hash of JSON with sorted keys (both in this plugin's files).
declare function isRisky(args: JsonObject): boolean;
declare function canonicalDigest(value: JsonValue): string;

export default defineFacet((host) => {
	contribute(host, "approvals", (self) => {
		const worker = workerOf(self);
		self.contribute(Signals, { [Approval.name]: Approval });
		self.contribute(Extensions, {
			approvals: {
				name: "approvals",
				hooks: [{
					stage: "check",
					hook: hook(ToolTask, {
						beforeTool: async (call, api, context) => {
							if (call.name !== "bash" || !isRisky(call.arguments)) return undefined;
							const key = canonicalDigest(call.arguments);
							const state = await api.readSignal(Approval, key, context);
							if (state !== undefined)
								return "expired" in state ? { block: "No approval within a day" } : state.value.allow ? undefined : { block: "Not approved" };
							const until = await api.memo(`approvals.until.${key}`, api.now() + DAY, context);
							// The record a person answers (section 2); idempotent, so every pass may write it.
							await worker().root(async (ctx) => (await ctx.get(Waits, {})).open({
								task: api.taskId, signal: Approval.name, key, until,
								answer: { kind: "person", title: `Run: ${String(call.arguments.command)}`, payload: { command: call.arguments.command } },
							}, ctx), context);
							return { sleep: { signals: [Approval.key(key)], until } };
						},
					}),
				}],
			},
		});
	});
});
```

```ts
// plugins/quota/worker.ts (sketch of its extension): a claim and its release
{
	name: "quota",
	hooks: [
		{ stage: "claim", hook: hook(ToolTask, { beforeTool: async (call, api, context) => {
			if (!METERED.has(call.name)) return undefined;
			// The quota plugin's server object, reserved idempotently by the task's ID (section 2.5 explains effects).
			const reserved = await worker().root(async (ctx) => (await ctx.get(Quota, {})).reserve({ task: api.taskId, tool: call.name }, ctx), context);
			return reserved.kind === "reserved" ? undefined : { sleep: { until: reserved.opensAt } };
		} }) },
		{ stage: "observe", hook: hook(ToolTask, { afterTool: async (call, _result, api, context) => {
			if (METERED.has(call.name))
				await worker().root(async (ctx) => (await ctx.get(Quota, {})).release({ task: api.taskId }, ctx), context);
		} }) },
	],
}
```

A third-party task with gates of its own declares a hook whose result may block or sleep (S§9) and applies Durable's
`beforeTool` rule itself: the first block or sleep in extension order wins. Plugins contribute its hooks with stages
like any other, so its transforms, checks, claims and observers run in the same order:

```ts
// plugins/release/worker.ts, inside a phase of ReleaseTask
type RegionDecision = { readonly block?: string; readonly sleep?: { readonly until?: number; readonly signals?: readonly SignalKey<unknown>[] } };
let decision: RegionDecision | undefined;
await runtime.hooks.each("beforeRegion", async (handler) => {
	if (decision === undefined) decision = (await handler(step, api, context)) ?? undefined;   // the first that decides
});
if (decision?.sleep !== undefined)
	return runtime.commit(() => ({ status: "sleeping", checkpoint, ...decision.sleep }), context);
```

### 1.6 What stays unguaranteed

A `check` that returns `{ arguments }` still changes the call, and a `transform` that sleeps still parks it: Durable's
result types cannot tell the stages apart, and the composer does not inspect results of hooks it does not know.
Stages fix the order; a hook in the wrong stage is the plugin's bug. Only `observe` is enforced, for every task.
Wraps (`wrapTool`) keep decorating execution and never park (S§9).

## 2. Wait records

### 2.1 The problem

A parked task knows only its signal keys and its deadline (S§7). Someone must remember what it waits for (a question's
text, an approval's command, a webhook's correlation ID), show it, and turn an answer into `harness.signal()` in the
right session's worker, starting the worker if it is not running. Questions and webhooks need the same three things,
so they are one mechanism with two kinds of answerer.

### 2.2 Contracts (`plugins/waits/`)

```ts
// plugins/waits/contract.ts
import { arr, int, lit, num, obj, oneOf, opt, str, union, unknown, type Static } from "@earendil-works/pi-schema";
import { method, param, remote, serverHost, sessionHost } from "@p2/app/v1";

/** Who answers a wait: a person (shown by the asking plugin's renderer) or a service (found by its match). */
export const Answerer = union([
	obj({ kind: lit("person"), title: str(), payload: unknown() }),   // payload: small JSON for the renderer
	obj({ kind: lit("service"), match: str() }),                     // a correlation ID the service sends back
]);

/** One open wait, as its task opens it: the task, the token's name, the key, an optional deadline, the answerer. */
const WaitFields = { task: int(), signal: str(), key: str(), until: opt(num()), answer: Answerer };
export const WaitOpen = obj(WaitFields);
export const WaitRecord = obj({ ...WaitFields, session: str(), opened: num() });
export type WaitRecord = Static<typeof WaitRecord>;

/** What `harness.signal()` answered (S§3.2). */
export const SignalOutcome = oneOf(["delivered", "duplicate", "invalid", "closed", "not_found"]);

/** A session worker's link to the index: its principal names the session. */
export const WaitReports = remote("waits.reports", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				open: method(WaitOpen),
				/** The waits of these tasks are over (the tasks ended): their records go. */
				ended: method(obj({ tasks: arr(int()) })),
			},
		},
	},
});

/** Delivery into a session's worker; started on demand. Only the server holds it. */
export const WaitDelivery = remote("waits.delivery", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: { methods: { deliver: method(obj({ task: int(), signal: str(), key: str(), value: unknown() }), SignalOutcome) } },
	},
});

/** The waits people answer, per principal: the owner sees every session's. */
export const PersonWaits = remote("waits.person", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { open: arr(WaitRecord) },
			methods: { answer: method(obj({ session: str(), task: int(), signal: str(), key: str(), value: unknown() }), SignalOutcome) },
		},
	},
});
```

```ts
// plugins/waits/contract.server.ts
/** The index of open waits (server, host lifetime); its table belongs to it alone. */
export const WaitIndex = local("waits.index", {
	version: 1,
	params: {},
	members: {
		/** Open waits a person answers, every session's: a live query over its table (at most 200). */
		persons: arr(WaitRecord),
		/** Records answered by a service whose `match` is this; for the plugin's own webhook route. */
		byMatch: method(obj({ match: str() }), arr(WaitRecord)),
		/** Delivers `value` into the record's session (starting its worker) and settles the record by the outcome. */
		deliver: method(obj({ session: str(), task: int(), signal: str(), key: str(), value: unknown() }), SignalOutcome),
		/** Writes a record (idempotent: its identity is its key); `WaitReports.open` calls it with the worker's session. */
		put: method(WaitRecord),
		/** Removes every record of these tasks of `session`; `WaitReports.ended` calls it. */
		removeTasks: method(obj({ session: str(), tasks: arr(int()) })),
	},
});

// plugins/waits/contract.worker.ts
/** The worker's side (host lifetime): opens records for Durable code and closes those of ended tasks. */
export const Waits = local("waits.worker", { version: 1, params: {}, members: { open: method(WaitOpen) } });
```

`Signals` is a worker registry in p2's runtime, beside `Extensions`: token name to token, so the worker can deliver a
value for a token it only knows by name.

```ts
// src/runtime/worker.ts
/** Signal tokens by name (`defineSignal`), contributed by the plugins whose tasks and hooks sleep on them. */
export const Signals = keyedRegistry<SignalToken<unknown>>("p2.signals");
```

### 2.3 The server

```ts
// plugins/waits/server.ts (the index; the person view and the delivery route through it)
const WaitsTable = defineTable("waits.open", {
	version: 1,
	// `answerer` is "person" or "service" and `match` is "" for a person: index columns are non-opt str or int.
	columns: { session: str(), task: int(), signal: str(), key: str(), answerer: str(), match: str(), record: json(WaitRecord, { version: 1 }) },
	key: ["session", "task", "signal", "key"],
	indexes: { by_match: ["match"], by_answerer: ["answerer", "session"] },
});

host.serve(WaitIndex, (_params, self) => {
	const table = self.table(WaitsTable);
	const server = serverOf(self);
	return {
		byMatch: async ({ match }, ctx) =>
			(await table.page(query(WaitsTable).where((t) => eq(t.match, match)), 100, ctx)).items.map((row) => row.record),
		deliver: async ({ session, task, signal, key, value }, ctx) => {
			// As the server (design §4): the worker's delivery object refuses anyone else.
			const outcome = await server().root(async (root) =>
				expectVariant(await root.get(WaitDelivery, { session }), "server").deliver({ task, signal, key, value }, root),
				withoutAbortSignal(ctx));
			// A wait that cannot take a value any more goes; delivered and duplicate stay until their task ends.
			if (outcome === "closed" || outcome === "not_found")
				await self.tx(async (tx) => tx.delete(table, { session, task, signal, key }), ctx);
			return outcome;
		},
		put: async (record, ctx) => {
			const { session, task, signal, key, answer } = record;
			const row = { session, task, signal, key, answerer: answer.kind, match: answer.kind === "service" ? answer.match : "", record };
			await self.tx(async (tx) => tx.put(table, row), ctx);
			return null;
		},
		removeTasks: async ({ session, tasks }, ctx) => {
			await self.tx(async (tx) => tx.deleteWhere(table, (t) => and(eq(t.session, session), inArray(t.task, tasks))), ctx);
			return null;
		},
	};
});

host.serve(WaitReports, (_params, principal, self) => {
	if (!isWorker(principal)) throw forbidden("only session workers report waits");
	const index = self.get(WaitIndex, {});
	const session = principal.session;
	return {
		variant: "worker",
		members: {
			open: async (wait, ctx) => index.put({ ...wait, session, opened: Date.now() }, ctx),
			ended: async ({ tasks }, ctx) => index.removeTasks({ session, tasks }, ctx),
		},
	};
});
```

A repeated `open` rewrites the same row. `WaitIndex.persons` is a
live query over the `by_answerer` index (`self.query(table, query(WaitsTable).where((t) => eq(t.answerer,
"person")), 200)`, mapped to the records by a derive): only the table's owner may query it. `PersonWaits` (owner
variant) holds `WaitIndex` and exposes `persons` as its `open`; its `answer` checks that the row exists and is
answered by a person, then calls `WaitIndex.deliver`.

### 2.4 The worker

```ts
// plugins/waits/worker.ts
/** The tasks this worker opened records for and has not reported ended: persisted, so a restart still closes them. */
const Opened = defineState("waits.opened", {
	schema: obj({ tasks: arr(int()) }),
	version: 1,
	initial: () => ({ tasks: [] }),
	persist: true,
	checkpointWhen: () => true,
});

host.serve(Waits, (_params, self) => {
	const harness = harnessOf(self);
	const reports = self.get(WaitReports, {});
	const opened = self.state(Opened);
	const graph = self.follow((observer, ctx) => harness().durable.observeTaskGraph(observer, ctx));
	// A task in the list that is no longer live has ended: its records go (one call per change that ended any).
	self.on(graph, async ({ value }, ctx) => {
		const live = (value as TaskGraph).tasks;
		const ended = opened.value.tasks.filter((task) => live[String(task)] === undefined);
		if (ended.length === 0) return;
		await expectVariant(reports, "worker").ended({ tasks: ended }, ctx);
		await opened.change((draft) => { draft.tasks = draft.tasks.filter((task) => !ended.includes(task)); }, ctx);
	});
	return {
		open: async (wait, ctx) => {
			if (!opened.value.tasks.includes(wait.task)) await opened.change((draft) => { draft.tasks.push(wait.task); }, ctx);
			await expectVariant(reports, "worker").open(wait, ctx);
			return null;
		},
	};
});

host.serve(WaitDelivery, (_params, principal, self) => {
	if (principal?.kind !== "server") throw forbidden("only the server delivers signals");
	const harness = harnessOf(self);
	const signals = self.registry(Signals);
	return {
		variant: "server",
		members: {
			deliver: async ({ task, signal, key, value }, ctx) => {
				const token = signals.value.get(signal);
				// A plugin removed while its task waits: nothing can read the value; the record shows it.
				if (token === undefined) return "closed";
				// The token's schema checks the value (S§3.2): a wrong one answers `invalid`.
				return harness().durable.signal(task as TaskId, token, key, value, ctx);
			},
		},
	};
});
```

The `opened` list is written before the record, so a crash between them leaves a task to check, never a record nobody
closes. The graph routine does one array filter per graph change and calls the server only when a task with records
ended.

### 2.5 Records are effects

A hook or tool that opens a record performs an external effect (S§5.3): not atomic with its task's commit, repeated on
every pass of a gate and on a replay-safe rerun. That is why the record's identity is (session, task, signal, key) and
`open` overwrites. A record whose task never parked (the call was blocked by a later check) is closed when the task
ends. Records hold small JSON: the renderer's payload is a command or a question, never a diff or a log (S§3.5); larger
things go in the asking plugin's own documents and the payload names them.

### 2.6 A person answers

```ts
// plugins/waits/contract.web.ts
/** How a wait of one signal token looks and is answered; contributed by the plugin that defines the token. */
export type WaitRenderer = ComponentType<{ readonly wait: WaitRecord; readonly answer: (value: JsonValue) => Promise<void> }>;
export const WaitRenderers = keyedRegistry<WaitRenderer>("waits.renderers");   // key: the token's name

// plugins/approvals/web.tsx
self.contribute(WaitRenderers, {
	[Approval.name]: ({ wait, answer }) => (
		<Card title={wait.answer.kind === "person" ? wait.answer.title : ""}>
			<Button onClick={() => answer({ allow: true })}>Allow</Button>
			<Button onClick={() => answer({ allow: false })}>Deny</Button>
		</Card>
	),
});
```

Any page that lists person waits (an inbox plugin, the transcript's card for a parked call, section 4.3) holds
`PersonWaits`, picks the renderer by `wait.signal`, and calls `answer` with the record's identity and the value;
without a renderer it shows the title and "answer in the asking plugin's UI". Chat bridges (Discord) answer through
the same method from their server part. A late joiner sees the same list: records are state.

### 2.7 A service answers (webhooks)

The plugin that talks to the service owns its route and checks the service's signature; the index finds the task:

```ts
// plugins/ci/server.ts
self.contribute(Routes, {
	"POST /ci/webhook": async (request, response, _access, ctx) => {
		const body = await readVerified(request, ciSecret);   // the plugin's own check of the service's signature
		if (body === undefined) return sendJson(response, 401, { error: "bad signature" });
		const index = await ctx.get(WaitIndex, {});
		const [wait] = await index.byMatch({ match: body.correlationId }, ctx);
		if (wait === undefined) return sendJson(response, 404, { error: "no such run" });
		const outcome = await index.deliver({ ...wait, value: { status: body.status, logUrl: body.logUrl } }, ctx);
		// Final answers stop the service's retries: duplicate is a success, closed is gone.
		const status = { delivered: 200, duplicate: 200, invalid: 400, closed: 410, not_found: 404 }[outcome];
		sendJson(response, status, { outcome });
	},
});
```

The `run_ci` tool of S§4.1 replaces the spec's `webhooks.expect(...)` with
`Waits.open({ task, signal: CiResult.name, key: "done", until, answer: { kind: "service", match: runId } })` through
`worker().root(...)`, before it triggers the build.

## 3. The wake handoff and liveness

### 3.1 The problem

p2's worker counts every task-graph node as work (`plugins/status/worker.ts` `summarize` feeds
`Liveness.setDurableTasks`), so a session waiting a day for an approval keeps its process a day. With parked work,
liveness must come from `harness.wake()`: `active` while something can run, `at` for the earliest deadline (S§8). A
worker may exit only after something that outlives it holds that `at`, because nothing waits for `onWake` (S§8).

### 3.2 The worker

The core opens the Harness with `onWake` (`src/runtime/worker.ts`, `DurableHarness.open`). With `onWake`, Durable arms
no timer for sleeps; the worker arms its own while it runs and reports every value:

```ts
// src/runtime/worker.ts, the HarnessHost factory
const wake = self.writable<Wake>({ active: true });   // until the first onWake: Harness.open recovers first
let timer: ReturnType<typeof setTimeout> | undefined;
// in DurableHarness.open's options:
onWake: (next) => {
	wake.set(next);
	clearTimeout(timer);
	// While the process lives, it resumes due sleeps itself; unref: an idle worker may still exit.
	if (next.at !== undefined) timer = setTimeout(() => reader?.resume(), Math.max(0, next.at - Date.now())).unref();
},
```

`Liveness` replaces `durableTasks` with two counts: `durableActive` (1 while `wake.active`) and `wakeHandoff` (1 while
the newest `at` is not acknowledged by the server). A routine pushes each value:

```ts
// plugins/status/worker.ts
self.on(wake, async ({ value: next }, ctx) => {
	worker().liveness.setDurableActive(next.active);
	worker().liveness.setWakeHandoff(true);
	// Answers once the server committed it; a throw is retried by Chord with backoff, the handoff count stays 1.
	await expectVariant(wakes, "worker").due({ at: next.at ?? null }, ctx);
	worker().liveness.setWakeHandoff(false);
});
```

The worker exits idle only when every count is zero (`workerMain`'s `busy`, unchanged), so a deadline is on the
server before the process goes. A signal for a session with no worker needs no handoff: the delivery holds the
worker's object and starts it (section 2.4).

### 3.3 The server

```ts
// plugins/status/contract.ts
/** Each session's next deadline, kept durably by the server; a worker reports its own (its principal names it). */
export const WakeReports = remote("p2.wake-reports", {
	version: 1, params: {}, hostAddress: serverHost,
	variants: { worker: { methods: { due: method(obj({ at: union([num(), nul()]) })) } } },
});
/** Starts a session's worker for a due deadline; only the server holds it. */
export const SessionWake = remote("p2.session-wake", {
	version: 1, params: { session: param.str() }, hostAddress: sessionHost,
	variants: { server: { methods: { wake: method() } } },
});
/** The server's table of deadlines and the loop that starts due workers (host lifetime). */
export const WakeAlarm = local("p2.wake-alarm", {
	version: 1, params: {},
	members: { due: method(obj({ session: str(), at: union([num(), nul()]) })) },
});
```

`WakeReports` is served for worker principals (`isWorker`) and calls `WakeAlarm.due` with `principal.session`.

```ts
// plugins/status/server.ts
const Wakes = defineState("p2.status-wakes", {   // Chord's defineState: persisted (p2's defineTypedState is in memory only)
	schema: obj({ at: record(num()) }), version: 1, initial: () => ({ at: {} }), persist: true, checkpointWhen: () => true,
});

host.serve(WakeAlarm, (_params, self) => {   // local, host lifetime; serves WakeReports' `due` through its method
	const wakes = self.state(Wakes);
	const hosts = self.get(Hosts, {});
	const server = serverOf(self);
	self.onLive(async (ctx) => {
		for (;;) {
			const seen = wakes.value;
			const now = Date.now();
			for (const [session, at] of Object.entries(seen.at)) {
				// A running worker resumes its own sleeps (section 3.2).
				if (at > now || hosts.workers.value[session]?.running) continue;
				await server().root(async (root) => expectVariant(await root.get(SessionWake, { session }), "server").wake(root), ctx);
			}
			const next = Math.min(...Object.values(seen.at).filter((at) => at > now));
			// Until the earliest deadline, or until a report changes the table, whichever is first.
			const limit = Number.isFinite(next) ? AbortSignal.timeout(next - now) : undefined;
			// The timeout's rejection is the deadline arriving: the loop checks the table again.
			await until(wakes, (value) => value !== seen, limit ? withAbortSignal(limit, ctx) : ctx).catch(() => {});
			if (ctx.abortSignal?.aborted) return;
		}
	});
	return {
		due: async ({ session, at }, ctx) => {
			await wakes.change((draft) => { if (at === null) delete draft.at[session]; else draft.at[session] = at; }, ctx);
			return null;
		},
	};
});
```

The worker's `SessionWake.wake` calls `harness().durable.resume()` and returns; holding it started the worker, whose
Harness open recovers and runs what is due, then reports its new `at`. After a server restart the table is read again
at activation, so deadlines survive both processes.

### 3.4 Status and the sidebar

The status report gains the conversations whose foreground work is all parked, so the sidebar shows "waiting" instead
of the working dot:

```ts
// plugins/status/worker.ts
/** Whether a task waits for the outside world: sleeping, or waiting only on tasks that are themselves parked. */
function parked(graph: TaskGraph, node: TaskGraphNode, seen = new Set<TaskId>()): boolean {
	if (node.state.status === "sleeping") return true;
	if (node.state.status !== "waiting" || seen.has(node.id)) return false;
	seen.add(node.id);
	return node.state.on.every((id) => { const child = graph.tasks[String(id)]; return child === undefined || parked(graph, child, seen); });
}

function summarize(graph: TaskGraph): { tasks: number; busy: number[]; waiting: number[] } {
	const foreground = Object.values(graph.tasks).filter((node) => !node.background);
	const conversations = [...new Set(foreground.map((node) => node.conversationId))].sort((a, b) => a - b);
	const allParked = (c: number) => foreground.filter((node) => node.conversationId === c).every((node) => parked(graph, node));
	return {
		tasks: Object.keys(graph.tasks).length,
		busy: conversations.filter((c) => !allParked(c)),
		waiting: conversations.filter(allParked),
	};
}
```

`StatusSchema` and `ReportFields` gain `waiting: arr(num())`; `setDurableTasks` goes (section 3.2 replaces it).

## 4. The transcript and activity

### 4.1 Tool cards

`src/web/transcript.ts`: `ToolStatus` gains `"sleeping" | "waiting"`, passed through from `slot.status` (S§10 names
the line), and a parked card is not interrupted when the run is busy. The card shows "Waiting" with the slot's
`until` when there is one.

### 4.2 Activity

`plugins/agent/activity.tsx` and the chat's busy indicator test `pending` and `running` only; a parked call counts as
waiting, not as idle and not as working.

### 4.3 What a parked card shows

A parked tool card looks up the session's person waits by the slot's `taskId` (`PersonWaits.open`, filtered by session
and task) and renders each with its `WaitRenderers` entry inline: the approval's Allow and Deny buttons sit in the
transcript where the call waits. Service waits show the slot's deadline only.

## 5. Order of building

1. Stages in `durable.ts` and the `P2Extension` type; existing hook users (cache-warming's `afterResponse`) become
   `observe`. One test: a transform, a check, a claim and an observer from four plugins sorted against their stages.
2. `onWake`, `Liveness` counts, `WakeReports`, `WakeAlarm`, `SessionWake`; the `waiting` status.
3. The `waits` plugin: index, worker side, delivery, `PersonWaits`, renderers; the approvals plugin as its first user.
4. Transcript and activity statuses; the CI webhook example as a test plugin.

Each step needs the Durable build of the suspendable spec; step 1 does not.

## 6. In p3

The same three concepts, on p3's base:

- **Stages** live on p3's harness contribution: `hooks?: readonly StagedHook[]` beside tools, sections, wraps, tasks
  and filters; the composer is the harness plugin's registry `compose`, as `installStaged` above.
- **Wait records** are rows of the waits plugin's server table with a `host(Session)` column (Chord decision
  "Documents and table rows can belong to a host"), so a session's export, import and delete carry its open waits;
  `session: str()` becomes that column.
- **Wake deadlines** are a host-keyed document `defineState("status.wake", { keyed: Session, ... })`, one per session,
  for the same reason.
- p3 principals: the person view's variant is `user`, not `owner`; delivery and wake objects check `server` as here.

## 7. Open points

1. **Claims held by a pass that never reached intent** (raised by c1e54598, 2026-11-09; mainly for p3). A block or
   abort releases a claim through the claiming plugin's observe-stage `afterTool`, but a pass that ends in a sleep does
   not, so the slot is held for as long as the call waits. Two traces:
   - A crash between a claim and the intent commit. The rerun asks every check again. Approvals cannot change (the
     stored signal, first writer wins), but time and configuration can: quiet hours began (the check sleeps until
     morning), or a policy changed (the check blocks, which does release). In the sleep case, the crashed pass's
     reservation stays held.
   - Several claims in one pass. Quota A reserves; quota B is full and sleeps. On wake the checks run first and one of
     them now sleeps. A's slot stays held for the whole wait.

   Two fixes, neither needing Durable:
   (a) A claim means "reserved for this pass". Claims contribute their release beside the claim (`{ stage: "claim",
   hook, release }`, release idempotent by task ID). The composer wraps every check and claim hook: when one returns
   `block` or `sleep`, it calls every claim plugin's release for that task before returning, so the next pass
   reserves again. This also covers the crashed pass, since a release does not need to know whether a reservation
   exists.
   (b) The quota plugin reserves with a short lease that the intent confirms (its observe-stage `beforeTool` runs
   once a pass passed every gate), so an unconfirmed reservation expires by itself. This also covers crashes the
   composer never sees.

   Recommendation: (b) for quota plugins in any case, since it is their own correctness; (a) only if a second kind
   of claim needs it.
