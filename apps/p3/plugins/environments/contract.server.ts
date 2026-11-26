// The environments plugin's contract for server facets: what server code reaches a machine through. `MachineHosts`
// gives a machine's files and commands (`ExecutionEnv`) and its terminals (`Pty`); `reachMachine` is how Files and
// Terminals check, through the things plugin's index, that the caller may use a machine in a workspace before they
// touch it. This device's machine is the kind's one thing (`OneThing`, the things plugin's). `/v1/server` re-exports
// it.

import { type Context, defineRegistry, forbidden } from "@earendil-works/p3/v1";
import type { ExecutionEnv } from "@earendil-works/p3/v1/server";
import type { Caller } from "../things/contract.ts";
import { messages } from "./messages.ts";

/**
 * How a terminal starts: its folder, its size, and where its output goes (raw bytes, in order; each array is handed
 * over, never written again).
 */
export type PtyOptions = {
	readonly cwd: string;
	readonly columns: number;
	readonly rows: number;
	readonly onData: (bytes: Uint8Array) => void;
};

/**
 * A program running in a pseudo-terminal on a machine (the user's shell). It ends when the program exits or `close`
 * kills it; `exited` resolves with the exit code then.
 */
export type Pty = {
	write(data: string): void;
	resize(columns: number, rows: number): void;
	close(): void;
	readonly exited: Promise<number>;
};

/**
 * A machine as server code uses it: its files and commands, the folders never shown (Pi's own data folder on this
 * device), and its terminals.
 */
export type MachineHost = {
	readonly env: ExecutionEnv;
	readonly hidden: readonly string[];
	openPty(options: PtyOptions, context: Context): Promise<Pty>;
};

/** Gives the host of machine `machine` (a thing id), or `undefined` when this contribution does not serve it. */
export type MachineHostResolver = (machine: string) => MachineHost | undefined;

/** The machines' hosts: each machine kind's plugin contributes a resolver; the first that answers wins. */
export const MachineHosts = defineRegistry<MachineHostResolver, MachineHostResolver>("environments.hosts", {
	version: 1,
});

/** The caller's answer on a machine, as `Gives` (the things plugin's index) has it: absent when it gets nothing. */
export type MachineAnswer = { readonly ticks: readonly string[] } | undefined;

/**
 * Whether `caller` may use a machine, given its answer on it in a workspace: a person needs any answer (the machine is
 * available to them here), an agent Work here; the server (trusted code) always may.
 */
export function machineAvailable(caller: Caller, answer: MachineAnswer): boolean {
	switch (caller.kind) {
		case "server":
			return true;
		case "person":
			return answer !== undefined;
		case "agent":
			return answer?.ticks.includes("work") === true;
	}
}

/**
 * The host of machine `machine` for `caller` in a workspace, given its answer on it there (`machineAvailable`).
 * Refuses with the message the person sees otherwise.
 */
export function reachMachine(
	machine: string,
	caller: Caller,
	answer: MachineAnswer,
	hosts: MachineHostResolver,
): MachineHost {
	if (!machineAvailable(caller, answer)) {
		const agent = caller.kind === "agent" && answer !== undefined;
		throw forbidden(`environments: machine ${machine} is not available to the caller here`, {
			message: messages.message(agent ? "noWork" : "notHere"),
		});
	}
	const host = hosts(machine);
	if (host === undefined) {
		throw forbidden(`environments: machine ${machine} is not available here`, {
			message: messages.message("notHere"),
		});
	}
	return host;
}
