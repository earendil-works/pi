// The end-to-end harness: p3's real server in this process on a temporary data directory, with its built-in plugins
// and the probe (`test/probe/`, copied into a root of the test's own, so a test may edit and apply it), its session
// workers as real processes; and clients signed in as the owner over WebSocket, as a browser's page would be.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createHost, type Host, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";
import { WorkerRunners, type WorkerState } from "@earendil-works/p3/v1/server";
import { SessionsStore } from "../plugins/sessions/contract.server.ts";
import type { SessionState } from "../plugins/sessions/contract.ts";
import { PLUGINS, WORKER } from "../src/install.ts";
import { type RunningServer, type ServerError, startServer } from "../src/server.ts";

/** A test's server and what it needs around it. */
export type TestServer = {
	readonly server: RunningServer;
	readonly dataDir: string;
	/** The test's own plugin root: the probe's directory is `<plugins>/probe`. */
	readonly plugins: string;
	/** What the server reported in the background. */
	readonly errors: ServerError[];
	/** A new client signed in as the owner (closed with the server). */
	client(): Promise<Host<P3Principal>>;
	/** Each session's worker as the runner sees it. */
	workers(): Promise<Readonly<Record<string, WorkerState>>>;
	/** Sets session `id`'s state on the server, as its worker's report does. */
	report(id: string, state: SessionState): Promise<void>;
	/** Closes the server and starts a new one on the same data directory. */
	restart(): Promise<TestServer>;
	/** Closes the clients and the server; removes the data directory unless `keep`. */
	close(keep?: boolean): Promise<void>;
};

/** How long a worker idles before it stops itself in the tests. */
export const IDLE_MS = 300;

/** Starts a server on a new data directory (or again on `dataDir`). */
export async function testServer(dataDir?: string): Promise<TestServer> {
	const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "p3-test-")));
	const plugins = join(dir, "plugins");
	const errors: ServerError[] = [];
	const server = await startServer(
		{
			dataDir: dir,
			roots: [
				{ path: PLUGINS, required: true },
				{ path: fileURLToPath(new URL("./plugins/", import.meta.url)), required: true },
				{ path: plugins, required: false },
			],
			port: 0,
			version: "test",
			worker: WORKER,
			workerIdleMs: IDLE_MS,
			onStop: () => {},
			onError: (error) => errors.push(error),
		},
		context,
	);
	const clients: Host<P3Principal>[] = [];
	const close = async (keep = false): Promise<void> => {
		for (const client of clients) await client.close(context);
		await server.close(context);
		if (!keep) await rm(dir, { recursive: true, force: true });
	};
	return {
		server,
		dataDir: dir,
		plugins,
		errors,
		client: async () => {
			const client = await ownerClient(dir, server.port);
			clients.push(client);
			return client;
		},
		report: async (id, state) => {
			await server.runtime.host.root(
				async (ctx) => (await ctx.get(SessionsStore, {})).report({ id, state }, ctx),
				context,
			);
		},
		workers: async () => (await server.runtime.host.registry(WorkerRunners, context)).value?.state() ?? {},
		restart: async () => {
			await close(true);
			return testServer(dir);
		},
		close,
	};
}

/** A client host connected over WebSocket with the owner token file's bearer token, loaded with no plugins. */
async function ownerClient(dataDir: string, port: number): Promise<Host<P3Principal>> {
	const token = await eventually(async () => (await readFile(join(dataDir, "owner-token"), "utf8")).trim());
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers: { authorization: `Bearer ${token}` } } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	const client = createHost<P3Principal>({
		readyTimeout: 10_000,
		onError: (error) => console.error("client:", error),
	});
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}

/**
 * The first result of `probe` that does not throw and passes `done`, tried every 25 ms; rejects with the last error
 * after `ms`. For effects in other processes (a worker's exit), which no watchable shows here.
 */
export async function eventually<T>(
	probe: () => Promise<T>,
	done: (value: T) => boolean = () => true,
	ms = 10_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	let last: unknown = new Error("eventually: nothing passed");
	for (;;) {
		try {
			const value = await probe();
			if (done(value)) return value;
			last = new Error(`eventually: ${JSON.stringify(value)} did not pass`);
		} catch (error) {
			last = error;
		}
		if (Date.now() > deadline) throw last;
		await sleep(25);
	}
}

/** Whether process `pid` lives. */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
