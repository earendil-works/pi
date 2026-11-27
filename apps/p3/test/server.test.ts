// The server's bootstrap (`src/server.ts`) apart from its workers' processes: the base's registries (`LinkOpened`
// calls every plugin's hook on its own, `ServerCommands` keeps a name's first command and reports a second), the order
// of its close (the data directory's socket, its lock, last, after the store), its answers on that socket (the control
// plugin's `apply`, an unknown command, a command while it starts), a failed plugin of the user's root reported, the
// runner it uses (the one runner, a second reported and not used, the wraps composed over it once) and the route's
// start of a worker while no runner is contributed.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createHost, type HostError } from "@earendil-works/chord";
import { type Context, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import {
	contribute,
	defineFacet,
	type P3Principal,
	Session,
	SessionWorker,
	until,
	WebScripts,
} from "@earendil-works/p3/v1";
import {
	type HttpRequest,
	LinkOpened,
	type LinkOpenedHook,
	ServerCommands,
	type ServerRuntime,
	ThingsStore,
	type WorkerRunner,
	WorkerRunners,
	WorkerRunnerWraps,
} from "@earendil-works/p3/v1/server";
import { testServer } from "@earendil-works/p3/v1/testing";
import { PLUGINS, WORKER } from "../src/install.ts";
import { exchange, serverSocket } from "../src/local-socket.ts";
import {
	type RunningServer,
	type ServerEnd,
	type ServerError,
	serverCoreFacet,
	startServer,
	startWorker,
	usedRunner,
} from "../src/server.ts";
import { makeSession, TMP } from "./support.ts";
import { eventually } from "./until.ts";

/** A host with the base's facet and one plugin per entry of `plugins`, each contributing what its facet does. */
async function hostWith(t: TestContext, plugins: Readonly<Record<string, ReturnType<typeof defineFacet>>>) {
	const errors: HostError[] = [];
	const host = createHost<P3Principal>({ onError: (error) => errors.push(error) });
	t.after(() => host.close(context));
	// The base's facet reads nothing of the runtime here.
	const core = serverCoreFacet({} as ServerRuntime);
	const facets = Object.entries(plugins).map(([name, facet]) => ({ name, facet }));
	await host.load([{ name: "p3.server", facet: core }, ...facets], context);
	return { host, errors };
}

/** A plugin's facet contributing `hook` to `LinkOpened`. */
function hooking(hook: LinkOpenedHook) {
	return defineFacet((_host, self) => self.contribute(LinkOpened, hook));
}

describe("the base's registries", () => {
	// Sol, review round 2 (S3): one plugin's hook that threw kept every later plugin from seeing the link, and one
	// disposer that threw kept the later ones from running.
	it("`LinkOpened` calls every plugin's hook and disposer on its own: one that throws is reported, the rest run", async (t) => {
		const seen: string[] = [];
		const { host } = await hostWith(t, {
			a: hooking(() => () => void seen.push("a ended")),
			b: hooking(() => {
				throw new Error("b's hook");
			}),
			c: hooking(() => {
				seen.push("c opened");
				return () => {
					throw new Error("c's disposer");
				};
			}),
			d: hooking(() => () => void seen.push("d ended")),
		});
		const reported: string[] = [];
		const spy = mock.method(console, "error", (line: string) => void reported.push(line));
		try {
			const opened = (await host.registry(LinkOpened, context)).value;
			const end = opened({} as HttpRequest, () => {});
			assert.deepEqual(seen, ["c opened"]);
			end?.();
		} finally {
			spy.mock.restore();
		}
		assert.deepEqual(seen, ["c opened", "a ended", "d ended"]);
		assert.equal(reported.length, 2);
		assert.match(reported[0]!, /p3: b's link hook: Error: b's hook/);
		assert.match(reported[1]!, /p3: c's link hook: Error: c's disposer/);
	});

	it("`ServerCommands` keeps a name's first command by plugin name and reports the second", async (t) => {
		const command = (said: string) =>
			defineFacet((host) =>
				contribute(host, `${said}.command`, (self) =>
					self.contribute(ServerCommands, { name: "hello", run: async () => said }),
				),
			);
		const { host, errors } = await hostWith(t, { b: command("b"), a: command("a") });
		const commands = (await host.registry(ServerCommands, context)).value;
		assert.equal(await commands.get("hello")?.run(context), "a");
		assert.deepEqual(
			errors.map((error) => error.kind),
			["registry_conflict"],
		);
	});
});

/** The answer of the holder at `path` (`undefined`: none); a holder that did not answer in `ms` fails the case. */
async function answerOf(path: string, request: unknown, ms?: number): Promise<unknown> {
	const reply = await exchange(path, request, ms);
	assert.notEqual(reply.kind, "silent", `${path} did not answer`);
	return reply.kind === "answered" ? reply.answer : undefined;
}

/** Facets of the server's own, loaded with its plugins. */
type Facets = readonly { name: string; facet: ReturnType<typeof defineFacet> }[];

/**
 * A server starting on a new data directory with the built-in plugins, `facets`, and the data directory's user root
 * (`plugins`, not required) holding `plugins`' files; what its `onStop` and `onError` heard.
 */
async function starting(t: TestContext, facets: Facets = [], plugins: Readonly<Record<string, string>> = {}) {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-server-"));
	const root = join(dataDir, "plugins");
	await mkdir(root, { recursive: true });
	for (const [file, source] of Object.entries(plugins)) await writeFile(join(root, file), source);
	const ends: ServerEnd[] = [];
	const errors: ServerError[] = [];
	const started = startServer(
		{
			dataDir,
			roots: [
				{ path: PLUGINS, required: true },
				{ path: root, required: false },
			],
			port: 0,
			version: "test",
			worker: WORKER,
			facets,
			onStop: (end) => void ends.push(end),
			onError: (error) => void errors.push(error),
		},
		context,
	);
	t.after(async () => {
		await (await started.catch(() => undefined))?.close(context);
		await rm(dataDir, { recursive: true, force: true });
	});
	return { started, dataDir, ends, errors };
}

/** `starting`, once the server runs. */
async function server(t: TestContext, facets: Facets = [], plugins: Readonly<Record<string, string>> = {}) {
	const { started, ...rest } = await starting(t, facets, plugins);
	return { running: await started, ...rest };
}

/** Holds the worker of a new session of `running` until the hold's call returns: the worker starts. */
async function startOne(running: RunningServer): Promise<string> {
	const host = running.runtime.host;
	const [owner] = (
		await host.root(async (ctx) => (await ctx.get(ThingsStore, {})).persons.owners.page({}, 1, ctx), context)
	).items;
	return host.root(
		async (ctx) => {
			const id = await makeSession(ctx, "one", TMP);
			await ctx.get(SessionWorker, { session: id });
			return id;
		},
		context,
		{ principal: { kind: "person", id: owner!.person, name: owner!.name } },
	);
}

/** A wrap over `inner` that runs everything on it, telling `seen` of each start and reload. */
function passing(inner: WorkerRunner, seen: string[]): WorkerRunner {
	return {
		start: (address, ctx) => {
			seen.push(`start ${address.params.id}`);
			return inner.start(address, ctx);
		},
		stop: (id) => inner.stop(id),
		retry: (id) => inner.retry(id),
		remove: (id) => inner.remove(id),
		stored: () => inner.stored(),
		state: () => inner.state(),
		pids: () => inner.pids(),
		reload: (built, ctx) => {
			seen.push("reload");
			return inner.reload(built, ctx);
		},
	};
}

describe("the server", () => {
	// Opus, review round 2 (B1, M11): nothing failed when the socket, the data directory's lock, was released first, so
	// a next server could open the store while this one still closed it.
	it("releases the data directory's socket last: it still answers while the host closes", async (t) => {
		const asked: unknown[] = [];
		let dataDir = "";
		const closing = defineFacet((host) =>
			contribute(host, "test.closing", (self) => {
				self.open(
					async () => null,
					async () => void asked.push(await answerOf(serverSocket(dataDir), { kind: "status" })),
				);
			}),
		);
		const started = await server(t, [{ name: "test.closing", facet: closing }]);
		dataDir = started.dataDir;
		await started.running.close(context);
		assert.equal((asked[0] as { readonly kind?: string } | undefined)?.kind, "running");
		assert.equal(await answerOf(serverSocket(dataDir), { kind: "status" }), undefined);
	});

	// Astra, review round 3 (B4): releasing the socket between the host's close and the store's left the suite green; a
	// next server could open the store while this one still closed it.
	it("releases the data directory's socket only after its store closed", async (t) => {
		const { running, dataDir } = await server(t);
		const { store } = running.runtime;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const close = store.close.bind(store);
		store.close = async (ctx) => {
			entered.resolve();
			await gate.promise;
			return close(ctx);
		};
		const closing = running.close(context);
		try {
			await entered.promise;
			assert.equal(
				((await answerOf(serverSocket(dataDir), { kind: "status" })) as { kind?: string })?.kind,
				"running",
			);
		} finally {
			gate.resolve();
		}
		await closing;
		assert.equal(await answerOf(serverSocket(dataDir), { kind: "status" }), undefined);
	});

	// D11: the owner's stop and apply are the control plugin's commands over the socket, no longer HTTP routes. (The
	// command `stop` is the command's test: `test/command.test.ts`.)
	it("applies on the control plugin's command `apply`, answering each step and its lines; the old routes are gone", async (t) => {
		const { running, dataDir } = await server(t);
		const applied = (await answerOf(serverSocket(dataDir), { kind: "command", name: "apply" }, 60_000)) as {
			readonly kind: string;
			readonly value: {
				readonly steps: readonly { readonly name: string }[];
				readonly stopped: unknown;
				readonly lines: readonly string[];
			};
		};
		assert.equal(applied.kind, "answer");
		assert.deepEqual(
			applied.value.steps.map(({ name }) => name),
			["server", "workers", "web"],
		);
		assert.equal(applied.value.stopped, null);
		// Nothing changed: the server's own host reloaded, no worker runs, the page's first set was published.
		assert.deepEqual(applied.value.lines, ["server  server  reloaded", "web  web  reloaded"]);
		for (const path of ["/_p3/stop", "/_p3/apply", "/_p3/owner/link"]) {
			const answer = await fetch(`http://127.0.0.1:${running.port}${path}`, { method: "POST" });
			assert.equal(answer.status, 404, path);
		}
	});

	// Fable, review round 3 (S3): an unknown command answered as `invalid` left the suite green.
	it("answers a command no plugin serves as unknown, by its name, and a request of another shape as invalid", async (t) => {
		const { dataDir } = await server(t);
		const path = serverSocket(dataDir);
		assert.deepEqual(await answerOf(path, { kind: "command", name: "nope" }), { kind: "unknown", name: "nope" });
		assert.deepEqual(await answerOf(path, { kind: "command" }), { kind: "invalid" });
		assert.deepEqual(await answerOf(path, { kind: "bogus" }), { kind: "invalid" });
	});

	// Astra, review round 4 (open point b of round 3): a command while the plugins load answers `starting`, the answer
	// `p3 stop` asks again on; only a stand-in pinned that side.
	it("answers a command while its plugins load with `starting`, and runs it once they did", async (t) => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const gated = defineFacet((host) =>
			contribute(host, "test.gated", (self) => {
				self.open(
					async () => {
						entered.resolve();
						await gate.promise;
						return null;
					},
					() => {},
				);
			}),
		);
		const { started, dataDir, ends } = await starting(t, [{ name: "test.gated", facet: gated }]);
		const stop = { kind: "command", name: "stop" };
		try {
			await entered.promise;
			const asked = (await answerOf(serverSocket(dataDir), stop)) as { readonly kind?: string };
			assert.equal(asked.kind, "starting");
		} finally {
			gate.resolve();
		}
		await started;
		assert.deepEqual(ends, [], "the stop asked while it started did not run");
		assert.deepEqual(await answerOf(serverSocket(dataDir), stop), { kind: "answer", value: "stopping" });
		await eventually(
			() => ends,
			(heard) => heard.length === 1,
		);
		assert.deepEqual(ends, [{ kind: "stopped" }]);
	});

	// Fable, review round 3 (S4): a plugin of the user's root that failed at the start was left out without a word.
	it("reports a plugin of a root that is not required that fails at the start, and starts without it", async (t) => {
		const { errors } = await server(t, [], {
			"broken.server.ts":
				'import { defineFacet } from "@earendil-works/p3/v1";\nexport default defineFacet(() => { throw new Error("broken setup"); });\n',
			"syntax.server.ts": "export default ((\n",
		});
		const failed = errors.flatMap((error) => (error.kind === "plugin_failed" ? [error.error.plugin] : []));
		assert.deepEqual(failed.sort(), ["broken", "syntax"]);
	});
});

describe("the route's start of a worker", () => {
	// Astra, review round 2 (nit), and Opus S4, review round 3: a start while no runner is contributed (the runner plugin
	// reloads) waits for the next one; nothing pinned that the hold's end ends that wait.
	it("while no runner is contributed, rejects at its context's abort, also one that came before it", async (t) => {
		const { host } = await hostWith(t, {});
		const used = usedRunner(host, context);
		const before = new AbortController();
		before.abort(new Error("the hold ended before"));
		const early = startWorker(used, Session({ id: "s" }), withAbortSignal(before.signal, context));
		await assert.rejects(early, /the hold ended before/);
		const during = new AbortController();
		const waiting = startWorker(used, Session({ id: "s" }), withAbortSignal(during.signal, context));
		await new Promise((resolve) => setImmediate(resolve));
		during.abort(new Error("the hold ended"));
		await assert.rejects(waiting, /the hold ended/);
	});
});

describe("the runner the server uses", () => {
	// Decided in review round 4 (Astra B1): a second runner that sorted first took over the route while the first one
	// still ran a held worker, which the status then left out. One runner; how workers run changes by wraps.
	it("is the one runner with the wraps over it: a wrap sees every start and the apply's reload, composed once", async (t) => {
		const seen: string[] = [];
		let composed = 0;
		const wrapping = defineFacet((_host, self) =>
			self.contribute(WorkerRunnerWraps, (inner) => {
				composed++;
				return passing(inner, seen);
			}),
		);
		const { running } = await server(t, [{ name: "test.wrap", facet: wrapping }]);
		const one = await startOne(running);
		const two = await startOne(running);
		await running.runtime.apply(context);
		assert.deepEqual(seen, [`start ${one}`, `start ${two}`, "reload"]);
		assert.equal(composed, 1, "composed once for the one runner and its wraps");
		assert.deepEqual(Object.keys((await running.runner.now(context))?.state() ?? {}).sort(), [one, two].sort());
	});

	it("reports a second runner as a conflict naming both plugins, and does not use it", async (t) => {
		const refusing: WorkerRunner = {
			start: () => Promise.reject(new Error("the second runner was used")),
			stop: async () => {},
			retry: () => {},
			remove: async () => {},
			stored: async () => [],
			state: () => ({}),
			pids: () => [],
			reload: async () => ({ hosts: [] }),
		};
		const second = defineFacet((_host, self) => self.contribute(WorkerRunners, refusing));
		const { running, errors } = await server(t, [{ name: "test.runner", facet: second }]);
		await startOne(running);
		const conflicts = errors.flatMap(({ kind, error }) =>
			kind === "host" && error.kind === "registry_conflict" ? [error] : [],
		);
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0]?.registry, WorkerRunners.name);
		assert.deepEqual(conflicts[0]?.plugins, ["@earendil-works/p3-runner", "test.runner"]);
	});
});

describe("the apply", () => {
	/** A test server with the runner's `reload` held at its first call until `finish` resolves. */
	async function heldReload(t: TestContext) {
		const running = await testServer({}, context);
		t.after(() => running.close(context));
		const runners = (await running.host.registry(WorkerRunners, context)).value;
		assert.ok(runners !== undefined);
		const reload = runners.reload.bind(runners);
		const reached = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		t.after(() => finish.resolve());
		let first = true;
		t.mock.method(runners, "reload", async (built: Parameters<WorkerRunner["reload"]>[0], ctx: Context) => {
			const result = await reload(built, ctx);
			if (first) {
				first = false;
				reached.resolve();
				await finish.promise;
			}
			return result;
		});
		return { running, reached, finish };
	}

	// Review of the perf pass (Astra, ERNDL-1060): apply A's workers step was delayed, an edit, apply B finished, then A:
	// both reported success, the page went back to A's code, nothing was dirty, and a third apply did not repair it.
	it("runs one build and rollout at a time: a newer apply is not undone by an older one finishing late", async (t) => {
		const { running, reached, finish } = await heldReload(t);
		const file = join(running.userRoot, "race.web.ts");
		const write = (said: string) => writeFile(file, `export default { setup() { globalThis.said = "${said}"; } };`);
		await write("a");
		await until(running.plugins, ({ dirty, set }) => set || dirty.includes("race"), context);
		const scripts = await running.host.get(WebScripts, {}, context);
		t.after(() => scripts.release());
		const older = running.apply(context);
		await reached.promise;
		await write("b");
		await until(running.plugins, ({ dirty }) => dirty.includes("race"), context);
		// Round 2 (Astra): the newer apply reads what is dirty when it builds; while the older one is held it reads nothing.
		const reads = t.mock.getter(running.plugins, "value");
		const newer = running.apply(context);
		// Unheld, it reads within this turn's microtasks.
		await tick();
		const read = reads.mock.callCount();
		reads.mock.restore();
		finish.resolve();
		assert.equal(read, 0, "the newer apply started while the older one was held");
		assert.equal((await older).stopped, undefined);
		assert.equal((await newer).stopped, undefined);
		assert.deepEqual(running.plugins.value.dirty, []);
		const shown = scripts.set.value.combined;
		const headers = { cookie: await running.cookie(context) };
		const combined = await (await fetch(`http://127.0.0.1:${running.port}${shown}`, { headers })).text();
		assert.equal(/said\s*=\s*"(\w+)"/.exec(combined)?.[1], "b");
		await running.apply(context);
		assert.equal(scripts.set.value.combined, shown);
	});

	// Round 2 (Astra): a queued apply whose caller left waited for the one before it, and built once its turn came.
	it("lets a queued apply's caller stop waiting: its apply builds nothing, the next one still waits", async (t) => {
		const { running, reached, finish } = await heldReload(t);
		const first = running.apply(context);
		await reached.promise;
		const controller = new AbortController();
		const second = running.apply(withAbortSignal(controller.signal, context));
		controller.abort(new Error("the caller left"));
		// It rejects at the abort, while the first apply is still held.
		const settled = await Promise.race([
			second.then(
				() => "applied",
				(error: Error) => error.message,
			),
			tick(),
		]);
		assert.equal(settled, "the caller left");
		const reads = t.mock.getter(running.plugins, "value");
		const third = running.apply(context);
		// Unheld, it reads within this turn's microtasks.
		await tick();
		const read = reads.mock.callCount();
		reads.mock.restore();
		finish.resolve();
		assert.equal(read, 0, "the third apply started while the first was held");
		assert.equal((await first).stopped, undefined);
		assert.equal((await third).stopped, undefined);
	});
});
