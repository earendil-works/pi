// The environments plugin's contract for server facets: what server code reaches a machine through. A machine is a
// thing of one family kind (decision 117) whose type other plugins contribute (`MachineTypes`: its label, its
// settings' schema, and `connect`, which gives the machine's host); this device is the first type. `MachineHosts` gives
// a machine's host, connected from its type and settings: its files and commands (`ExecutionEnv`, plus the two file
// operations Files needs that it lacks) and its programs in pseudo-terminals (`Pty`), every member answering a
// `Result` with a `FileError`, as `ExecutionEnv`'s do. `TerminalHost` runs the terminals of every machine, keyed by
// terminal id, for the plugin's lifetime, so a reload of the plugin that shows them loses none. `checkMachine` and
// `reachMachine` are how Files and Terminals check, through the things plugin's index, that the caller may use a
// machine in a workspace before they touch it; `abortWhen` is how their streams end once that changes. This device's
// machine is the kind's one thing (`OneThing`, the things plugin's). `/v1/server` re-exports it.

import {
	arr,
	type Context,
	defineRegistry,
	forbidden,
	local,
	type MessageData,
	method,
	type NativeWatchable,
	obj,
	type Schema,
	str,
	type TableItem,
	until,
} from "@earendil-works/p3/v1";
import type { ExecutionEnv, FileError, Result } from "@earendil-works/p3/v1/server";
import type { Caller } from "../things/contract.ts";
import { TerminalRow } from "./contract.ts";
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

/** A folder's entry as `listNames` gives it (in the order the folder has them): its name and kind, not reading it. */
export type NameEntry = { readonly name: string; readonly kind: "file" | "directory" | "symlink" };

/**
 * A file being written for an upload, in the folder it lands in, under a name of its own (`MachineHost.stageFile`):
 * only its owner may read it while it is written. `publish` lands it whole at a path, `discard` removes it; whichever
 * is called first settles it (each closes it), and a publish once called has won: a discard after it waits for it and
 * removes nothing that landed.
 */
export type StagedFile = {
	/** Where it was made. */
	readonly path: string;
	/** What tells it apart from any file that later has its path (`removeStaged` checks it). */
	readonly identity: string;
	/** Appends `bytes`. */
	write(bytes: Uint8Array, context: Context): Promise<Result<void, FileError>>;
	/**
	 * Moves it over `path` whole: with the permission bits of the regular file it replaces (without setuid, setgid and
	 * sticky), or a new file's ordinary ones (`0666` less the umask); never broader than that. Refused once discarded.
	 */
	publish(path: string, context: Context): Promise<Result<void, FileError>>;
	/** Removes it, where it is now (its folder may have moved meanwhile), unless a publish landed it (`landed`). */
	discard(context: Context): Promise<Result<"removed" | "landed", FileError>>;
};

/**
 * A machine as server code uses it, connected: its files and commands, the folders never shown (Pi's own data folder
 * on this device), a folder's names and kinds, at most `max` (`listNames`: no entry is read, for paging a large
 * folder; `Infinity`: all; stops when `context` aborts), a new file for an upload (`stageFile`: made exclusively in
 * `folder`, so it never writes through a link) and the removal of one a crash left (`removeStaged`: only while the
 * file at its path is still that staged file, `absent` otherwise), its programs in pseudo-terminals (`not_supported`
 * where it has none), and `close`, which ends the connection (its settings changed, the machine or the plugin went).
 */
export type MachineHost = {
	readonly env: ExecutionEnv;
	readonly hidden: readonly string[];
	listNames(
		folder: string,
		max: number,
		context: Context,
	): Promise<Result<{ readonly names: readonly NameEntry[]; readonly more: boolean }, FileError>>;
	stageFile(folder: string, context: Context): Promise<Result<StagedFile, FileError>>;
	removeStaged(path: string, identity: string, context: Context): Promise<Result<"removed" | "absent", FileError>>;
	openPty(options: PtyOptions, context: Context): Promise<Result<Pty, FileError>>;
	close(context: Context): Promise<void>;
};

/**
 * A machine type (decision 117): its name (what a machine stores), its label in the picker that makes a machine, the
 * schema its settings are checked against when written, and `connect`, which gives the host of a machine with
 * `settings` (of that schema). A type's form on the page comes with the views.
 */
export type MachineType = {
	readonly type: string;
	readonly label: MessageData;
	readonly settings: Schema;
	connect(settings: unknown, context: Context): Promise<MachineHost>;
};

/** The machine types, by name: other plugins contribute them (the first by plugin name wins a name). */
export const MachineTypes = defineRegistry<MachineType, ReadonlyMap<string, TableItem<MachineType>>>(
	"environments.machine-types",
	{ version: 1 },
);

/**
 * The host of machine `machine` (a thing id), connected once per settings and kept; `undefined` when the machine is
 * not there or its type is not installed (it shows unavailable).
 */
export type MachineHostResolver = (machine: string, context: Context) => Promise<MachineHost | undefined>;

/** The machines' hosts: the environments plugin's one contribution. */
export const MachineHosts = defineRegistry<MachineHostResolver, MachineHostResolver>("environments.hosts", {
	version: 1,
});

/**
 * One owner's terminals, live (`TerminalHost.list`): one object per owner, so a change of another owner's terminals
 * reaches nobody holding this one.
 */
export const TerminalList = local("environments.terminal-list", {
	version: 1,
	params: { owner: str() },
	members: { terminals: arr(TerminalRow) },
});

/**
 * What `TerminalHost.open` starts: on `machine` in `folder`, at a size, for `owner`, at most `max` of the owner's
 * running.
 */
export type TerminalRequest = {
	readonly owner: string;
	readonly machine: string;
	readonly folder: string;
	readonly columns: number;
	readonly rows: number;
	readonly max: number;
};

/**
 * The terminals of every machine, for trusted server code (it checks no caller). Each belongs to an owner, a key its
 * opener chose (the terminals plugin: a Terminals thing in a workspace). Output is kept per terminal in a ring of its
 * last `TERMINAL_BACKLOG` bytes, counted from the terminal's first byte: `tail` copies it, `next` waits for what
 * follows an offset.
 */
export type TerminalHost = {
	/** The terminals of `owner`, oldest first: the same array while none of them changed. */
	list(owner: string): TerminalRow[];
	/** Calls `listener` with `owner`'s list after each change of it, until the answered stop is called. */
	watch(owner: string, listener: (rows: TerminalRow[]) => void): () => void;
	/** The owners that have terminals, running or ended. */
	owners(): string[];
	/**
	 * Starts a terminal and answers its id. Refused past `request.max` running terminals of the owner or the host's own
	 * bound, opens under way counted; an open the caller cancels, or that its machine's, its owner's or the host's end
	 * takes back, is refused and its program, if it came, closed.
	 */
	open(request: TerminalRequest, context: Context): Promise<string>;
	/** Types `data` into terminal `id`: whether its program got it (`false` once it ended, or with no such terminal). */
	write(id: string, data: string): boolean;
	/** Gives terminal `id` a new size. */
	resize(id: string, columns: number, rows: number): void;
	/** Ends terminal `id`'s program if it runs and forgets the terminal. */
	close(id: string): void;
	/** Closes every terminal whose owner starts with `prefix` (its Terminals thing gone). */
	closeOwners(prefix: string): void;
	/** Closes every terminal on `machine` (the machine gone). */
	closeMachine(machine: string): void;
	/** The last `max` bytes of terminal `id`'s kept output (at most `TERMINAL_BACKLOG`) and the offset its end has. */
	tail(id: string, max: number): { readonly end: number; readonly bytes: Uint8Array };
	/**
	 * The output of terminal `id` after offset `from` (at most `TERMINAL_FRAME` bytes), waiting until some comes;
	 * `from` moves up to the oldest byte kept when it fell behind. Empty once the terminal ended or closed and
	 * everything was read; rejects when `context` aborts.
	 */
	next(id: string, from: number, context: Context): Promise<{ readonly from: number; readonly bytes: Uint8Array }>;
};

/** How many bytes of a terminal's output its host keeps for viewers who come later. */
export const TERMINAL_BACKLOG = 256 * 1024;

/** How many bytes one `next` answers at most. */
export const TERMINAL_FRAME = 64 * 1024;

/** The terminal host: the environments plugin's one contribution. */
export const TerminalHosts = defineRegistry<TerminalHost, TerminalHost | undefined>("environments.terminals", {
	version: 1,
});

/**
 * The object that keeps the terminal host for the plugin's lifetime (it contributes it to `TerminalHosts`), and its
 * closing for the things' delete hooks, which get a `ctx`, not a registry: the terminals of a machine that went, and
 * of the owners whose key starts with `prefix` (a Terminals thing that went).
 */
export const TerminalKeeper = local("environments.terminal-keeper", {
	version: 1,
	params: {},
	members: {
		closeMachine: method(obj({ machine: str() })),
		closeOwners: method(obj({ prefix: str() })),
	},
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
 * Aborts `controller` once `lost` holds for `source`'s value (the current one included) or its watch ends, unless
 * `context` aborts first: how a stream holds what lets its caller in (decision 25) and ends the moment that goes.
 */
export function abortWhen<T>(
	source: NativeWatchable<T>,
	lost: (value: T) => boolean,
	controller: AbortController,
	context: Context,
): void {
	const end = () => controller.abort();
	void until(source, lost, context).then(end, end);
}

/** Refuses `caller` machine `machine`, given its answer on it in a workspace, unless `machineAvailable`. */
export function checkMachine(machine: string, caller: Caller, answer: MachineAnswer): void {
	if (machineAvailable(caller, answer)) return;
	const agent = caller.kind === "agent" && answer !== undefined;
	throw forbidden(`environments: machine ${machine} is not available to the caller here`, {
		message: messages.message(agent ? "noWork" : "notHere"),
	});
}

/**
 * The host of machine `machine` for `caller` in a workspace, given its answer on it there (`checkMachine`).
 * Refuses with the message the person sees otherwise, also when the machine is unavailable (its type not installed).
 */
export async function reachMachine(
	machine: string,
	caller: Caller,
	answer: MachineAnswer,
	hosts: MachineHostResolver,
	context: Context,
): Promise<MachineHost> {
	checkMachine(machine, caller, answer);
	const host = await hosts(machine, context);
	if (host === undefined) {
		throw forbidden(`environments: machine ${machine} is not available here`, {
			message: messages.message("notHere"),
		});
	}
	return host;
}
