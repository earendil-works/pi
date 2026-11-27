// The environments plugin's contract of its terminal host, for server facets: `TerminalHost` runs the terminals of
// every machine (a program in a `Pty` its machine's host started), keyed by terminal id, for the plugin's lifetime, so
// a reload of the plugin that shows them (terminals) loses none. Each terminal belongs to an owner: a Terminals thing
// in a workspace (`TerminalOwner`). `TerminalKeeper` keeps the host and closes terminals for the things' hooks;
// `TerminalList` is one owner's list, live.

import { arr, type Context, defineRegistry, local, method, obj, str } from "@earendil-works/p3/v1";
import { TerminalRow } from "./contract.ts";

/** Whose a terminal is: the Terminals thing and the workspace it was opened in. */
export type TerminalOwner = { readonly thing: string; readonly workspace: string };

/**
 * One owner's terminals, live (`TerminalHost.list`): one object per owner, so a change of another owner's terminals
 * reaches nobody holding this one.
 */
export const TerminalList = local("environments.terminal-list", {
	version: 1,
	params: { thing: str(), workspace: str() },
	members: { terminals: arr(TerminalRow) },
});

/** A terminal's size in character cells. */
export type TerminalSize = { readonly columns: number; readonly rows: number };

/**
 * What `TerminalHost.open` starts: on `machine` in `folder`, at a size, for `owner`, at most `max` of the owner's
 * running.
 */
export type TerminalRequest = {
	readonly owner: TerminalOwner;
	readonly machine: string;
	readonly folder: string;
	readonly columns: number;
	readonly rows: number;
	readonly max: number;
};

/**
 * The terminals of every machine, for trusted server code (it checks no caller). Output is kept per terminal in a ring
 * of its last `TERMINAL_BACKLOG` bytes, counted from the terminal's first byte: `tail` copies it, `next` waits for
 * what follows an offset.
 */
export type TerminalHost = {
	/** The terminals of `owner`, oldest first: the same array while none of them changed. */
	list(owner: TerminalOwner): TerminalRow[];
	/** Calls `listener` with `owner`'s list after each change of it, until the answered stop is called. */
	watch(owner: TerminalOwner, listener: (rows: TerminalRow[]) => void): () => void;
	/** The owners that have terminals, running or ended. */
	owners(): TerminalOwner[];
	/**
	 * Starts a terminal and answers its id. Refused past `request.max` running terminals of the owner or the host's own
	 * bound, opens under way counted; an open the caller cancels, or that its machine's, its owner's or the host's end
	 * takes back, is refused and its program, if it came, closed.
	 */
	open(request: TerminalRequest, context: Context): Promise<string>;
	/** Types `data` into terminal `id`: whether its program got it (`false` once it ended, or with no such terminal). */
	write(id: string, data: string | Uint8Array): boolean;
	/** Gives terminal `id` a new size. */
	resize(id: string, columns: number, rows: number): void;
	/**
	 * Calls `listener` with terminal `id`'s size now and after each change of it (viewers follow the size another set),
	 * until the answered stop or the terminal's close.
	 */
	followSize(id: string, listener: (size: TerminalSize) => void): () => void;
	/** Ends terminal `id`'s program if it runs and forgets the terminal. */
	close(id: string): void;
	/** Closes every terminal of Terminals thing `thing`, in every workspace (the thing gone). */
	closeThing(thing: string): void;
	/** Closes every terminal opened in `workspace` (the workspace gone). */
	closeWorkspace(workspace: string): void;
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
 * closing for the things' hooks, which get a `ctx`, not a registry: the terminals of a machine that went, of a
 * Terminals thing that went, and of a workspace that went.
 */
export const TerminalKeeper = local("environments.terminal-keeper", {
	version: 1,
	params: {},
	members: {
		closeMachine: method(obj({ machine: str() })),
		closeThing: method(obj({ thing: str() })),
		closeWorkspace: method(obj({ workspace: str() })),
	},
});
