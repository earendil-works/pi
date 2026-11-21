// The server's bootstrap (`src/server.ts`) apart from its workers: the base's registries (`LinkOpened` calls every
// plugin's hook on its own, `ServerCommands` keeps a name's first command and reports a second), the order of its
// close (the data directory's socket, its lock, last, after the store), its answers on that socket (the control
// plugin's `apply`, an unknown command), a failed plugin of the user's root reported, and the route's start of a worker
// while no runner is contributed.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, type TestContext } from "node:test";
import { createHost, type HostError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { contribute, defineFacet, type P3Principal, Session } from "@earendil-works/p3/v1";
import {
	type HttpRequest,
	LinkOpened,
	type LinkOpenedHook,
	ServerCommands,
	type ServerRuntime,
} from "@earendil-works/p3/v1/server";
import { PLUGINS, WORKER } from "../src/install.ts";
import { exchange, serverSocket } from "../src/local-socket.ts";
import { type ServerEnd, type ServerError, serverCoreFacet, startServer, startWorker } from "../src/server.ts";

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

/**
 * A server on a new data directory with the built-in plugins, `facets`, and the data directory's user root (`plugins`,
 * not required) holding `plugins`' files; what its `onStop` and `onError` heard.
 */
async function server(
	t: TestContext,
	facets: readonly { name: string; facet: ReturnType<typeof defineFacet> }[] = [],
	plugins: Readonly<Record<string, string>> = {},
) {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-server-"));
	const root = join(dataDir, "plugins");
	await mkdir(root, { recursive: true });
	for (const [file, source] of Object.entries(plugins)) await writeFile(join(root, file), source);
	const ends: ServerEnd[] = [];
	const errors: ServerError[] = [];
	const running = await startServer(
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
		await running.close(context);
		await rm(dataDir, { recursive: true, force: true });
	});
	return { running, dataDir, ends, errors };
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
			["server", "workers"],
		);
		assert.equal(applied.value.stopped, null);
		// Nothing changed: the server's own host reloaded, no worker runs.
		assert.deepEqual(applied.value.lines, ["server  server  reloaded"]);
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
		const before = new AbortController();
		before.abort(new Error("the hold ended before"));
		const early = startWorker(host, Session({ id: "s" }), withAbortSignal(before.signal, context));
		await assert.rejects(early, /the hold ended before/);
		const during = new AbortController();
		const waiting = startWorker(host, Session({ id: "s" }), withAbortSignal(during.signal, context));
		await new Promise((resolve) => setImmediate(resolve));
		during.abort(new Error("the hold ended"));
		await assert.rejects(waiting, /the hold ended/);
	});
});
