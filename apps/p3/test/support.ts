// The end-to-end harness: p3's real server in this process on a temporary data directory, with its built-in plugins,
// the tests' own root (`test/plugins/`: the probe, used in place) and the data directory's user root (`plugins`, where
// a test may write plugins and apply them), its session workers as real processes; clients signed in as the owner over
// WebSocket, as a browser's page is: with the cookie an owner link gives (`ownerCookie`, `ownerClient`). And what the
// command's and the release's tests and the bench share: a foreground `p3 server` (`launch`), a process's children
// (`childrenOf`), and a single-file worker plugin serving one value (`constantPlugin`).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, type Host, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type P3Principal, remote, Session, str } from "@earendil-works/p3/v1";
import { WorkerRunners, type WorkerState } from "@earendil-works/p3/v1/server";
import { PLUGINS, WORKER } from "../src/install.ts";
import { ASK_MS, askServer } from "../src/local-socket.ts";
import { type RunningServer, type ServerError, startServer } from "../src/server.ts";

/** A test's server and what it needs around it. */
export type TestServer = {
	readonly server: RunningServer;
	readonly dataDir: string;
	/** The data directory's user root (`<data directory>/plugins`), where a test writes plugins of its own. */
	readonly plugins: string;
	/** What the server reported in the background. */
	readonly errors: ServerError[];
	/** A new client signed in as the owner (closed with the server). */
	client(): Promise<Host<P3Principal>>;
	/** Each session's worker as the runner sees it. */
	workers(): Promise<Readonly<Record<string, WorkerState>>>;
	/** Closes the server and starts a new one on the same data directory. */
	restart(): Promise<TestServer>;
	/** Closes the clients and the server; removes the data directory unless `keep`. */
	close(keep?: boolean): Promise<void>;
};

/** How long a worker idles before it stops itself in the tests. */
export const IDLE_MS = 300;

/**
 * What a test's server starts with: `dataDir` to start again on one, `builtIn` for a copy of the built-in plugins
 * that the test edits and applies (the checkout's own by default).
 */
export type TestServerOptions = { readonly dataDir?: string; readonly builtIn?: string };

/** Starts a server on a new data directory (or again on `options.dataDir`). */
export async function testServer(options: TestServerOptions = {}): Promise<TestServer> {
	const dir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "p3-test-")));
	const plugins = join(dir, "plugins");
	const errors: ServerError[] = [];
	const server = await startServer(
		{
			dataDir: dir,
			roots: [
				{ path: options.builtIn ?? PLUGINS, required: true },
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
		workers: async () => (await server.runtime.host.registry(WorkerRunners, context)).value?.state() ?? {},
		restart: async () => {
			await close(true);
			return testServer({ ...options, dataDir: dir });
		},
		close,
	};
}

/**
 * A client host connected over WebSocket to the server of `dataDir` on `port`, signed in as the owner with a fresh
 * owner link's cookie, loaded with no plugins; a call waits `readyTimeout` ms at most for its object.
 */
export async function ownerClient(dataDir: string, port: number, readyTimeout = 10_000): Promise<Host<P3Principal>> {
	const cookie = await ownerCookie(dataDir, port);
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers: { cookie } } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	const client = createHost<P3Principal>({ readyTimeout, onError: (error) => console.error("client:", error) });
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}

/**
 * A fresh owner's sign-in cookie (`name=value`) from the server of `dataDir` on `port`, as `p3` and a browser get it:
 * the server's `owner-link` over its socket, then the link's token posted as the owner link's page posts it.
 */
export async function ownerCookie(dataDir: string, port: number): Promise<string> {
	const reply = await askServer(dataDir, { kind: "command", name: "owner-link" }, ASK_MS);
	if (reply.kind !== "answered" || reply.answer.kind !== "answer") {
		throw new Error(`ownerCookie: no owner link: ${JSON.stringify(reply)}`);
	}
	const token = new URL(String(reply.answer.value)).hash.slice(1);
	const signedIn = await fetch(`http://127.0.0.1:${port}/_p3/owner`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token }),
	});
	const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
	if (!signedIn.ok || cookie === undefined) throw new Error(`ownerCookie: the sign-in failed: ${signedIn.status}`);
	return cookie;
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

/** A `p3 server` launched in the foreground: its pid and port, once it printed its owner link. */
export type Launched = { readonly pid: number; readonly port: number; readonly dataDir: string; stop(): Promise<void> };

/**
 * Launches `p3 server` on `dataDir` on a free port, `command` being Node's arguments that run `p3` (a checkout's
 * `COMMAND`, or an installed release's `p3.js`), with `env` (this process's by default); resolves once it printed its
 * port and owner link.
 */
export async function launch(
	command: readonly string[],
	dataDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Launched> {
	const child = spawn(process.execPath, [...command, "server", "--dir", dataDir, "--port", "0"], {
		stdio: ["ignore", "pipe", "inherit"],
		env,
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const found = /port (\d+)\. Open/.exec(out);
			if (found !== null) resolve(Number(found[1]));
		});
		child.once("exit", (code) => reject(new Error(`p3 server exited with ${code}`)));
	});
	return { pid: child.pid!, port, dataDir, stop: () => stop(child) };
}

/** Stops `child` with `SIGTERM` and waits for its exit. */
async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await exited;
}

/** The children of process `pid`, each with its command line (`/proc/*\/stat`: Android has no `children` file). */
export async function childrenOf(pid: number): Promise<{ readonly pid: number; readonly args: readonly string[] }[]> {
	const children: { pid: number; args: string[] }[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		// A process may exit while it is read: it is none of the children then.
		const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
		if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== pid) continue;
		const command = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
		children.push({ pid: Number(entry), args: command.split("\0").filter((arg) => arg !== "") });
	}
	return children;
}

/** The contract of a plugin `constantPlugin` writes: one value on a session's worker, for the owner. */
export function constantContract(name: string) {
	return remote(`${name}.${name}`, {
		version: 1,
		params: { session: str() },
		hostAddress: ({ session }) => Session({ id: session }),
		variants: { owner: { state: { value: str() } } },
	});
}

/**
 * The source of single-file worker plugin `name` (`<name>.worker.ts`, written into a root) serving
 * `constantContract(name)` with `value`: a test writes it again with another value and applies it.
 */
export function constantPlugin(name: string, value: string): string {
	return `import { constant, defineFacet, remote, Session, str } from "@earendil-works/p3/v1";
const Constant = remote(${JSON.stringify(`${name}.${name}`)}, {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { value: str() } } },
});
export default defineFacet((host) => {
	host.serve(Constant, () => ({ variant: "owner", members: { value: constant(${JSON.stringify(value)}) } }));
});
`;
}
