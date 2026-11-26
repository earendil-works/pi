// The environments plugin's contract for server facets: what server code reaches a machine through. A machine is a
// thing of one family kind (decision 117) whose type other plugins contribute (`MachineTypes`: its label, its settings'
// schema, and `connect`, which gives the machine's host); this device is the first type. `MachineHosts` gives a
// machine's host, connected from its type and settings: its files and commands (`ExecutionEnv`, plus the two file
// operations Files needs that it lacks) and its programs in pseudo-terminals (`Pty`). `TerminalHost` runs the
// terminals of every machine, keyed by terminal id, for the plugin's lifetime, so a reload of the plugin that shows
// them loses none. `checkMachine` and `reachMachine` are how Files and Terminals check, through the things plugin's
// index, that the caller may use a machine in a workspace before they touch it. This device's machine is the kind's
// one thing (`OneThing`, the things plugin's). `/v1/server` re-exports it.

import {
	arr,
	type Context,
	defineRegistry,
	forbidden,
	int,
	lit,
	local,
	type MessageData,
	method,
	nul,
	obj,
	type Schema,
	type Static,
	str,
	type TableItem,
	union,
} from "@earendil-works/p3/v1";
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

/** A folder's entry as `listNames` gives it: its name and kind, without reading the entry itself. */
export type NameEntry = { readonly name: string; readonly kind: "file" | "directory" | "symlink" };

/** A file being written: bytes appended in order, `close` ends the writing (also after a failure). */
export type NewFile = {
	write(bytes: Uint8Array, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
};

/**
 * A machine as server code uses it, connected: its files and commands, the folders never shown (Pi's own data folder
 * on this device), a folder's names and kinds in one read (`listNames`: no entry is read, for paging a large folder), a
 * new file created exclusively (`createFile`: refused when the name exists, a symbolic link included, so it never
 * writes through one), its programs in pseudo-terminals, and `close`, which ends the connection (its settings changed,
 * the machine or the plugin went).
 */
export type MachineHost = {
	readonly env: ExecutionEnv;
	readonly hidden: readonly string[];
	listNames(folder: string, context: Context): Promise<readonly NameEntry[]>;
	createFile(path: string, context: Context): Promise<NewFile>;
	openPty(options: PtyOptions, context: Context): Promise<Pty>;
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
 * Who opened a terminal: the things plugin's `Caller`, repeated, since a file other plugins bundle may import no other
 * plugin's file.
 */
const Opener = union([
	obj({ kind: lit("person"), person: str() }),
	obj({ kind: lit("agent"), session: str() }),
	obj({ kind: lit("server") }),
]);

/**
 * A terminal as its host runs it: its id, the machine and folder it started in, its size, who opened it, and its exit
 * code once its program ended (`null` while it runs; it stays until closed, its output kept).
 */
export const TerminalRow = obj({
	id: str(),
	machine: str(),
	folder: str(),
	columns: int(),
	rows: int(),
	openedBy: Opener,
	exitCode: union([int(), nul()]),
});

/** A terminal as its host runs it (see `TerminalRow`). */
export type TerminalRow = Static<typeof TerminalRow>;

/**
 * One owner's terminals, live (`TerminalHost.list`): one object per owner, so a change of another owner's terminals
 * reaches nobody holding this one.
 */
export const TerminalList = local("environments.terminal-list", {
	version: 1,
	params: { owner: str() },
	members: { terminals: arr(TerminalRow) },
});

/** What `TerminalHost.open` starts: on `machine` in `folder`, at a size, for `owner`, at most `max` of the owner's. */
export type TerminalRequest = {
	readonly owner: string;
	readonly machine: string;
	readonly folder: string;
	readonly columns: number;
	readonly rows: number;
	readonly openedBy: TerminalRow["openedBy"];
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
	/** The owner of terminal `id`, `undefined` when there is none. */
	ownerOf(id: string): string | undefined;
	/**
	 * Starts a terminal and answers its id. Refused past `request.max` terminals of the owner or the host's own bound,
	 * opens under way counted.
	 */
	open(request: TerminalRequest, context: Context): Promise<string>;
	/** Types `data` into terminal `id`; nothing once its program ended. */
	write(id: string, data: string): void;
	/** Gives terminal `id` a new size. */
	resize(id: string, columns: number, rows: number): void;
	/** Ends terminal `id`'s program if it runs and forgets the terminal. */
	close(id: string): void;
	/** Closes every terminal whose owner starts with `prefix` (its Terminals thing gone). */
	closeOwners(prefix: string): void;
	/** Closes every terminal on `machine` (the machine gone). */
	closeMachine(machine: string): void;
	/** Terminal `id`'s kept output and the offset its end has. */
	tail(id: string): { readonly end: number; readonly bytes: Uint8Array };
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
