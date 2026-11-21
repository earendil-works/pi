// What the tests of the whole share besides `/v1/testing`'s `testServer`: the probe's directory (a plugin under test
// that drives a session's worker), a single-file worker plugin serving one value (`constantPlugin`), and for launched
// processes (the command's and the release's tests, the bench) a foreground `p3 server` (`launch`), a process's
// children (`childrenOf`) and whether a process lives (`alive`).

import { type ChildProcess, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { remote, Session, str } from "@earendil-works/p3/v1";

/** The probe (`test/plugins/probe/`): a test server's plugin under test (`testServer({ plugins: [PROBE] })`). */
export const PROBE = fileURLToPath(new URL("./plugins/probe/", import.meta.url));

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
