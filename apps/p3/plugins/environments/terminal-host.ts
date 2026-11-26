// The terminal host (`TerminalHost`): the terminals of every machine this plugin serves, keyed by terminal id, each
// with its program (a `Pty` the machine's host started) and its output ring (ring.ts). One per plugin load, made by
// its contribution (server.ts); its end kills every program, since nobody could reach one after. Lists are kept per
// owner and replaced only when one of the owner's terminals changes, so a change elsewhere wakes nobody here.

import { type Context, forbidden } from "@earendil-works/p3/v1";
import {
	type MachineHostResolver,
	type Pty,
	TERMINAL_BACKLOG,
	TERMINAL_FRAME,
	type TerminalHost,
	type TerminalRequest,
	type TerminalRow,
} from "./contract.server.ts";
import { messages } from "./messages.ts";
import { Ring } from "./ring.ts";

/** How many terminals one host runs at most, over every owner (opens under way counted). */
const MAX_HOSTED = 100;

/** A running or ended terminal: its row, owner, program (none once it exited), output and who waits for more. */
type Hosted = {
	row: TerminalRow;
	readonly owner: string;
	pty: Pty | undefined;
	readonly ring: Ring;
	readonly waiting: Set<() => void>;
	closed: boolean;
};

/** An open under way: whose, on which machine, and whether a close took it back meanwhile. */
type Pending = { readonly owner: string; readonly machine: string; cancelled: boolean };

/** The empty list, one value. */
const NONE: TerminalRow[] = [];

/** The terminal host over the machines `hosts` resolves (read at each open). */
export class Terminals implements TerminalHost {
	readonly #hosts: () => MachineHostResolver;
	readonly #terminals = new Map<string, Hosted>();
	readonly #lists = new Map<string, TerminalRow[]>();
	readonly #watchers = new Map<string, Set<(rows: TerminalRow[]) => void>>();
	readonly #pending = new Set<Pending>();
	#ended = false;

	constructor(hosts: () => MachineHostResolver) {
		this.#hosts = hosts;
	}

	list(owner: string): TerminalRow[] {
		return this.#lists.get(owner) ?? NONE;
	}

	watch(owner: string, listener: (rows: TerminalRow[]) => void): () => void {
		const listeners = this.#watchers.get(owner) ?? new Set();
		this.#watchers.set(owner, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && this.#watchers.get(owner) === listeners) this.#watchers.delete(owner);
		};
	}

	ownerOf(id: string): string | undefined {
		return this.#terminals.get(id)?.owner;
	}

	async open(request: TerminalRequest, context: Context): Promise<string> {
		const { owner, machine, folder, columns, rows, openedBy, max } = request;
		const at = this.#hosts()(machine);
		if (this.#ended || at === undefined) {
			throw forbidden(`environments: machine ${machine} runs no terminals here`, {
				message: messages.message("notHere"),
			});
		}
		let pendingOwn = 0;
		for (const pending of this.#pending) if (pending.owner === owner) pendingOwn++;
		if (this.list(owner).length + pendingOwn >= max || this.#terminals.size + this.#pending.size >= MAX_HOSTED) {
			throw forbidden(`environments: too many terminals for ${owner}`, { message: messages.message("tooMany") });
		}
		// The slot is taken before the await, so two opens cannot both pass the count.
		const pending: Pending = { owner, machine, cancelled: false };
		this.#pending.add(pending);
		const id = crypto.randomUUID();
		const hosted: Hosted = {
			row: { id, machine, folder, columns, rows, openedBy, exitCode: null },
			owner,
			pty: undefined,
			ring: new Ring(TERMINAL_BACKLOG),
			waiting: new Set(),
			closed: false,
		};
		// Output can come before `openPty` resolves: it is kept from the first byte on.
		const onData = (bytes: Uint8Array) => {
			if (hosted.closed) return;
			hosted.ring.write(bytes);
			wake(hosted);
		};
		let pty: Pty;
		try {
			pty = await at.openPty({ cwd: folder, columns, rows, onData }, context);
		} finally {
			this.#pending.delete(pending);
		}
		// Closed while it started (the host ended, the machine or the owner went): nobody could reach it.
		if (this.#ended || pending.cancelled) {
			pty.close();
			throw forbidden(`environments: terminal ${id} closed while it started`, {
				message: messages.message("notHere"),
			});
		}
		hosted.pty = pty;
		this.#terminals.set(id, hosted);
		this.#publish(owner, [...this.list(owner), hosted.row]);
		void pty.exited.then((exitCode) => {
			if (hosted.closed) return;
			// An ended program keeps its row and output until closed; its pseudo-terminal is released now.
			pty.close();
			hosted.pty = undefined;
			this.#change(hosted, { ...hosted.row, exitCode });
			wake(hosted);
		});
		return id;
	}

	write(id: string, data: string): void {
		this.#terminals.get(id)?.pty?.write(data);
	}

	resize(id: string, columns: number, rows: number): void {
		const hosted = this.#terminals.get(id);
		if (hosted === undefined) return;
		hosted.pty?.resize(columns, rows);
		this.#change(hosted, { ...hosted.row, columns, rows });
	}

	close(id: string): void {
		const hosted = this.#terminals.get(id);
		if (hosted === undefined) return;
		hosted.closed = true;
		hosted.pty?.close();
		hosted.pty = undefined;
		this.#terminals.delete(id);
		this.#publish(
			hosted.owner,
			this.list(hosted.owner).filter((row) => row.id !== id),
		);
		wake(hosted);
	}

	closeOwners(prefix: string): void {
		for (const pending of this.#pending) if (pending.owner.startsWith(prefix)) pending.cancelled = true;
		for (const [id, hosted] of this.#terminals) if (hosted.owner.startsWith(prefix)) this.close(id);
	}

	closeMachine(machine: string): void {
		for (const pending of this.#pending) if (pending.machine === machine) pending.cancelled = true;
		for (const [id, hosted] of this.#terminals) if (hosted.row.machine === machine) this.close(id);
	}

	tail(id: string): { readonly end: number; readonly bytes: Uint8Array } {
		const ring = this.#terminals.get(id)?.ring;
		return ring === undefined
			? { end: 0, bytes: new Uint8Array() }
			: { end: ring.end, bytes: ring.read(0, TERMINAL_BACKLOG) };
	}

	async next(
		id: string,
		from: number,
		context: Context,
	): Promise<{ readonly from: number; readonly bytes: Uint8Array }> {
		const hosted = this.#terminals.get(id);
		if (hosted === undefined) return { from, bytes: new Uint8Array() };
		for (;;) {
			const { ring } = hosted;
			if (from < ring.end) {
				const start = Math.max(from, ring.start);
				return { from: start, bytes: ring.read(start, TERMINAL_FRAME) };
			}
			if (hosted.closed || hosted.row.exitCode !== null) return { from, bytes: new Uint8Array() };
			await waitFor(hosted, context);
		}
	}

	/** Ends the host: every program is killed, every open under way taken back. */
	end(): void {
		this.#ended = true;
		for (const pending of this.#pending) pending.cancelled = true;
		for (const id of [...this.#terminals.keys()]) this.close(id);
	}

	/** Replaces `hosted`'s row with `row` in its owner's list. */
	#change(hosted: Hosted, row: TerminalRow): void {
		const old = hosted.row;
		hosted.row = row;
		this.#publish(
			hosted.owner,
			this.list(hosted.owner).map((each) => (each === old ? row : each)),
		);
	}

	/** Makes `rows` `owner`'s list and tells its watchers. */
	#publish(owner: string, rows: TerminalRow[]): void {
		if (rows.length === 0) this.#lists.delete(owner);
		else this.#lists.set(owner, rows);
		for (const listener of this.#watchers.get(owner) ?? []) listener(rows.length === 0 ? NONE : rows);
	}
}

/** Wakes everyone waiting for `hosted`'s output. */
function wake(hosted: Hosted): void {
	const waiting = [...hosted.waiting];
	hosted.waiting.clear();
	for (const resume of waiting) resume();
}

/** Waits until `hosted` has news (output, its end, its close); rejects when `context` aborts. */
function waitFor(hosted: Hosted, context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const aborted = () => {
			hosted.waiting.delete(resume);
			reject(signal?.reason);
		};
		const resume = () => {
			signal?.removeEventListener("abort", aborted);
			resolve();
		};
		hosted.waiting.add(resume);
		signal?.addEventListener("abort", aborted, { once: true });
	});
}
