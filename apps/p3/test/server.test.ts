// The server's bootstrap (`src/server.ts`) apart from its workers: the base's registries (`LinkOpened` calls every
// plugin's hook on its own, `ServerCommands` keeps a name's first command and reports a second), the order of its
// close (the data directory's socket, its lock, last), and the control plugin's commands over that socket.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock, type TestContext } from "node:test";
import { createHost, type HostError } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { contribute, defineFacet, type P3Principal } from "@earendil-works/p3/v1";
import {
	type HttpRequest,
	LinkOpened,
	type LinkOpenedHook,
	ServerCommands,
	type ServerRuntime,
} from "@earendil-works/p3/v1/server";
import { PLUGINS, WORKER } from "../src/install.ts";
import { ask, serverSocket } from "../src/local-socket.ts";
import { type ServerEnd, serverCoreFacet, startServer } from "../src/server.ts";

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

/** A server on a new data directory with the built-in plugins and `facets`; what its `onStop` heard. */
async function server(t: TestContext, facets: readonly { name: string; facet: ReturnType<typeof defineFacet> }[] = []) {
	const dataDir = await mkdtemp(join(tmpdir(), "p3-server-"));
	const ends: ServerEnd[] = [];
	const running = await startServer(
		{
			dataDir,
			roots: [{ path: PLUGINS, required: true }],
			port: 0,
			version: "test",
			worker: WORKER,
			facets,
			onStop: (end) => void ends.push(end),
			onError: () => {},
		},
		context,
	);
	t.after(async () => {
		await running.close(context);
		await rm(dataDir, { recursive: true, force: true });
	});
	return { running, dataDir, ends };
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
					async () => void asked.push(await ask(serverSocket(dataDir), { kind: "status" })),
				);
			}),
		);
		const started = await server(t, [{ name: "test.closing", facet: closing }]);
		dataDir = started.dataDir;
		await started.running.close(context);
		assert.equal((asked[0] as { readonly kind?: string } | undefined)?.kind, "running");
		assert.equal(await ask(serverSocket(dataDir), { kind: "status" }), undefined);
	});

	// D11: the owner's stop and apply are the control plugin's commands over the socket, no longer HTTP routes.
	it("stops on the control plugin's command `stop`, after answering it", async (t) => {
		const { dataDir, ends } = await server(t);
		assert.deepEqual(await ask(serverSocket(dataDir), { kind: "command", name: "stop" }), {
			kind: "answer",
			value: "stopping",
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(ends, [{ kind: "stopped" }]);
	});

	it("applies on the control plugin's command `apply`, answering each step; the old routes are gone", async (t) => {
		const { running, dataDir } = await server(t);
		const applied = (await ask(serverSocket(dataDir), { kind: "command", name: "apply" }, 60_000)) as {
			readonly kind: string;
			readonly value: { readonly steps: readonly { readonly name: string }[]; readonly stopped: unknown };
		};
		assert.equal(applied.kind, "answer");
		assert.deepEqual(
			applied.value.steps.map(({ name }) => name),
			["server", "workers"],
		);
		assert.equal(applied.value.stopped, null);
		for (const path of ["/_p3/stop", "/_p3/apply", "/_p3/owner/link"]) {
			const answer = await fetch(`http://127.0.0.1:${running.port}${path}`, { method: "POST" });
			assert.equal(answer.status, 404, path);
		}
	});
});
