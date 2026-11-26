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
	type Host,
	type P3Principal,
	remote,
	Session,
	Sessions,
	SessionsList,
	str,
	THIS_DEVICE,
	TRANSCRIPT_WRITES,
	Transcript,
	until,
} from "@earendil-works/p3/v1";
import { ensureLogin, setCredential } from "../plugins/providers/logins.ts";
import { assertGranted } from "./granted.ts";
import { FAUX_PROVIDER, keyOf, type Step } from "./plugins/faux-login/contract.ts";

/** The probe (`test/plugins/probe/`): a test server's plugin under test (`testServer({ plugins: [PROBE] })`). */
export const PROBE = fileURLToPath(new URL("./plugins/probe/", import.meta.url));

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
 * A coding session titled `title` in `folder`, made by the owner of `client`, with the faux login made in it by
 * `server` (the test server's host; `scriptFaux`), whose agent works until `folder` has a file `gate` (`openGate`): the faux login answers every
 * request with a bash call waiting for it (a run cut off asks again and waits again) until the gate is open. Its row
 * says `working` because the harness says so, as for any run: a test never reports a state the harness owns.
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
	const sessions = await client.get(Sessions, {}, context);
	const session = await sessions.create(
		{ app: "coding", title, location: { environment: THIS_DEVICE, folder } },
		context,
	);
	await scriptFaux(server, session, script, context);
	return session;
}

/** Lets a gated session's run (`gated`) in `folder` finish: its bash calls, on any worker, see the gate. */
export function openGate(folder: string): Promise<void> {
	return writeFile(join(folder, "gate"), "");
}

/**
 * Starts the agent's run in `session` (the owner's send through its transcript) and waits until the owner's list
 * shows the session `working`; holds nothing afterwards.
 */
export async function startRun(client: Host<P3Principal>, session: string, context: Context): Promise<void> {
	await client.root(async (ctx) => {
		const transcript = await ctx.get(Transcript, { session });
		assertGranted(transcript, ...TRANSCRIPT_WRITES);
		await transcript.send({ text: "go", requestId: "go" }, ctx);
		const list = await ctx.get(SessionsList, { app: "coding", set: "active", view: `run-${session}` });
		await until(list.list, (value) => value.rows.some((row) => row.id === session && row.state === "working"), ctx);
	}, context);
}

/** What the owner's `Sessions.create` takes for a new coding session titled `title` (on this device, in `/tmp`). */
export function coding(title: string) {
	return { app: "coding", title, location: { environment: THIS_DEVICE, folder: tmpdir() } };
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
