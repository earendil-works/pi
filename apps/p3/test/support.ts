// What the tests of the whole share besides `/v1/testing`'s `testServer`: the probe's directory (a plugin under test
// that drives a session's worker), the faux login's, its script in a session (`scriptFaux`) and a session whose agent
// works until the test opens its gate (`gatedSession`, `startRun`, `openGate`), a single-file worker plugin serving one value (`constantPlugin`), and for launched
// processes (the command's and the release's tests, the bench) a foreground `p3 server` (`launch`), a process's
// children (`childrenOf`), whether a process lives (`alive`) and when it started (`startOf`, to kill only that one).

import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Context,
	type Ctx,
	type Host,
	type Location,
	type P3Principal,
	Roots,
	remote,
	Session,
	SessionKind,
	SessionObject,
	str,
	THIS_DEVICE,
	Transcript,
	until,
	Workspace,
	withGranted,
} from "@earendil-works/p3/v1";
import { ensureLogin, setCredential } from "../plugins/providers/logins.ts";
import { FAUX_PROVIDER, FauxScript, keyOf, type Step } from "./plugins/faux-login/contract.ts";
import { Probe } from "./plugins/probe/contract.ts";

/** The probe (`test/plugins/probe/`): a test server's plugin under test (`testServer({ plugins: [PROBE] })`). */
export const PROBE = fileURLToPath(new URL("./plugins/probe/", import.meta.url));

/**
 * What session `session`'s worker reported since its start (a failed object, a failure nobody awaited), read through
 * the probe as `client`'s owner: a worker's reports go to its stderr, never to the test server's `errors`.
 */
export function workerReports(client: Host<P3Principal>, session: string, context: Context): Promise<string[]> {
	return client.root(async (ctx) => (await ctx.get(Probe, { session })).reported({}, ctx), context);
}

/** The faux login (`test/plugins/faux-login/`): a model login answering from a script, a plugin under test. */
export const FAUX = fileURLToPath(new URL("./plugins/faux-login/", import.meta.url));

/** A bash command that waits until the folder has a file `gate`, then says so. */
const UNTIL_GATE = "until [ -e gate ]; do sleep 0.05; done; echo opened";

/**
 * Scripts the faux login (`FAUX`) of `workspace` (a session's): makes it there the first time, as the server (its
 * kind's default grants give the agents Use), and replaces its credential, the script, afterwards. `server` is the
 * test server's host (`testServer`'s `host`); answers the login's thing id.
 */
export async function scriptFaux(
	server: Host<P3Principal>,
	workspace: string,
	script: readonly Step[],
	context: Context,
): Promise<string> {
	const credential = { type: "api_key", key: keyOf(script) };
	const by = { kind: "plugin", plugin: "p3-test-faux-login" } as const;
	return server.root(async (ctx) => {
		const thing = await ensureLogin({ name: "Faux", workspace, by, provider: FAUX_PROVIDER, credential }, ctx);
		await setCredential(thing, { provider: FAUX_PROVIDER, credential }, ctx);
		return thing;
	}, context);
}

/**
 * As `scriptFaux`, over a link: `client` is the owner's (a launched server's, the bench's), which reaches no store of
 * the server (Astra, round 1); the faux login plugin's `FauxScript` does it there. Answers the login's thing id.
 */
export async function scriptFauxAs(
	client: Host<P3Principal>,
	workspace: string,
	script: readonly Step[],
	context: Context,
): Promise<string> {
	return client.root(
		async (ctx) => (await ctx.get(FauxScript, {})).script({ workspace, script: [...script] }, ctx),
		context,
	);
}

/**
 * A session titled `title` working in `folder`, made in Pi by the owner of `client`, with the faux login made in it
 * by `server` (the test server's host; `scriptFaux`), whose agent works until `folder` has a file `gate` (`openGate`):
 * the faux login answers every request with a bash call waiting for it (a run cut off asks again and waits again)
 * until the gate is open. Its row says `working` because the harness says so, as for any run: a test never reports a
 * state the harness owns.
 */
export async function gatedSession(
	server: Host<P3Principal>,
	client: Host<P3Principal>,
	title: string,
	folder: string,
	context: Context,
): Promise<string> {
	const wait = { kind: "tool", name: "bash", args: JSON.stringify({ command: UNTIL_GATE }) } as const;
	const script: Step[] = [
		{ when: "opened", reply: [{ kind: "text", text: "done" }] },
		{ when: "", reply: [wait] },
	];
	const session = await newSession(client, title, context, { environment: THIS_DEVICE, folder });
	await scriptFaux(server, session, script, context);
	return session;
}

/** Lets a gated session's run (`gated`) in `folder` finish: its bash calls, on any worker, see the gate. */
export function openGate(folder: string): Promise<void> {
	return writeFile(join(folder, "gate"), "");
}

/**
 * Starts the agent's run in `session` (the owner's send through its transcript) and waits until the session's row
 * says `working`; holds nothing afterwards.
 */
export async function startRun(client: Host<P3Principal>, session: string, context: Context): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = withGranted(await ctx.get(Transcript, { session }), "send")!;
		await transcript.send({ text: "go", requestId: "go" }, ctx);
		const held = await ctx.get(SessionObject, { workspace: session, thing: session });
		await until(held.row, (row) => row.state === "working", ctx);
	}, context);
}

/**
 * A new session titled `title`, made in Pi by `client` (the owner: every tick of it) with `Workspace.make`, working at
 * `location` (left out: this device, in a folder of its own); answers its id.
 */
export function newSession(
	client: Host<P3Principal>,
	title: string,
	context: Context,
	location?: Location,
): Promise<string> {
	return client.root((ctx) => makeSession(ctx, title, location), context);
}

/** As `newSession`, as the caller of `ctx` (the owner, or anyone with Make of sessions in Pi). */
export async function makeSession(ctx: Ctx<P3Principal>, title: string, location?: Location): Promise<string> {
	const workspace = withGranted(await ctx.get(Workspace, { workspace: await piIn(ctx) }), "make")!;
	return workspace.make(
		{ kind: SessionKind.name, name: title, input: location === undefined ? {} : { location } },
		ctx,
	);
}

/** Pi, the root workspace, as `client` (the owner) sees it. */
export function piOf(client: Host<P3Principal>, context: Context): Promise<string> {
	return client.root(piIn, context);
}

/** Pi, as the caller of `ctx` sees it (their topmost workspace). */
async function piIn(ctx: Ctx<P3Principal>): Promise<string> {
	const roots = await ctx.get(Roots, { view: "test-pi" });
	return (await until(roots.list, (value) => value.rows.length > 0, ctx)).rows[0]!.workspace;
}

/** A location on this device in `/tmp`, for sessions whose folder no test reads. */
export const TMP: Location = { environment: THIS_DEVICE, folder: tmpdir() };

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
export type Launched = {
	readonly pid: number;
	readonly port: number;
	readonly dataDir: string;
	/** Its exit code once it exited (`null` when a signal ended it). */
	readonly exited: Promise<number | null>;
	/** Sends it `signal` unless it exited: never to another process that has its pid by now. */
	kill(signal: NodeJS.Signals): void;
	stop(): Promise<void>;
};

/**
 * `env` with the providers' catalog requests off (`P3_CATALOG_URL=off`), whatever the shell set: a test's p3 never
 * reaches pi.dev (Astra, round 2 of the catalog).
 */
export function offline(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...env, P3_CATALOG_URL: "off" };
}

/**
 * Launches `p3 server` on `dataDir` on a free port, `command` being Node's arguments that run `p3` (a checkout's
 * `COMMAND`, or an installed release's `p3.js`), with `env` (this process's by default) and its catalog requests off,
 * or at `catalog` (a test's fake); resolves once it printed its port and owner link. `stderr` gets its standard error
 * (this process's by default).
 */
export async function launch(
	command: readonly string[],
	dataDir: string,
	env: NodeJS.ProcessEnv = process.env,
	options: { readonly catalog?: string; readonly stderr?: (text: string) => void } = {},
): Promise<Launched> {
	const catalog = options.catalog ?? "off";
	const child = spawn(process.execPath, [...command, "server", "--dir", dataDir, "--port", "0"], {
		stdio: ["ignore", "pipe", options.stderr === undefined ? "inherit" : "pipe"],
		env: { ...env, P3_CATALOG_URL: catalog },
	});
	child.stderr?.on("data", (chunk: Buffer) => options.stderr?.(chunk.toString()));
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const found = /port (\d+)\. Open/.exec(out);
			if (found !== null) resolve(Number(found[1]));
		});
		child.once("exit", (code) => reject(new Error(`p3 server exited with ${code}`)));
	});
	// Node signals a child only until it reaped its exit.
	return {
		pid: child.pid!,
		port,
		dataDir,
		exited,
		kill: (signal) => void child.kill(signal),
		stop: () => stop(child),
	};
}

/** Stops `child` with `SIGTERM` and waits for its exit. */
async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await exited;
}

/**
 * When process `pid` started (its start time in `/proc/<pid>/stat`), which a later process given the same pid does not
 * share; `undefined` when it is gone or the system has no `/proc` (a cleanup then leaves it to `p3 stop`).
 */
export async function startOf(pid: number): Promise<string | undefined> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
	// The fields after the command's closing parenthesis, from the third (the state) on: the start time is the 22nd.
	return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
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
		state: { value: str() },
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
	state: { value: str() },
});
export default defineFacet((host) => {
	host.serve(Constant, () => ({ value: constant(${JSON.stringify(value)}) }));
});
`;
}
