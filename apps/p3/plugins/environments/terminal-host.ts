// The terminal host (`TerminalHost`): the terminals of every machine this plugin serves, keyed by terminal id, each
// with its program (a `Pty` the machine's host started) and its output ring (ring.ts). One per plugin load, made by
// its keeper (`serveTerminals`), which also serves each owner's list; its end kills every program, since nobody could
// reach one after. Lists are kept per owner and replaced only when one of the owner's terminals starts, ends or
// closes (a resize changes no row), so a change elsewhere wakes nobody here. Only running programs count against the
// bounds: an ended one keeps its row and output, not a slot, and an owner keeps at most `ENDED_ROWS` ended terminals
// and `ENDED_BYTES` of their output, the oldest let go first.

import {
	type Context,
	contribute,
	type FacetHost,
	forbidden,
	type P3Principal,
	withCancel,
} from "@earendil-works/p3/v1";
import type { FileError } from "@earendil-works/p3/v1/server";
import { type MachineHostResolver, MachineHosts, type Pty } from "./contract.server.ts";
import {
	TERMINAL_BACKLOG,
	TERMINAL_FRAME,
	type TerminalHost,
	TerminalHosts,
	TerminalKeeper,
	TerminalList,
	type TerminalOwner,
	type TerminalRequest,
	type TerminalSize,
} from "./contract.terminal-host.server.ts";
import type { TerminalRow } from "./contract.ts";
import { messages } from "./messages.ts";
import { Ring } from "./ring.ts";

/**
 * Serves the terminal host on `host`: the registry it is read through (`TerminalHosts`), the object that makes and
 * keeps it with its closing for the things' delete hooks (`TerminalKeeper`), and each owner's list (`TerminalList`).
 */
export function serveTerminals(host: FacetHost<P3Principal>): void {
	host.serve(TerminalHosts, { compose: (table) => table[0]?.value });
	host.serve(TerminalKeeper, (_params, self) => {
		const hosts = self.registry(MachineHosts);
		const terminals = new HostedTerminals(() => hosts.value);
		self.open(
			async () => terminals,
			(ended) => ended.end(),
		);
		self.contribute(TerminalHosts, terminals);
		return {
			closeMachine: async ({ machine }) => {
				terminals.closeMachine(machine);
				return null;
			},
			closeThing: async ({ thing }) => {
				terminals.closeThing(thing);
				return null;
			},
			closeWorkspace: async ({ workspace }) => {
				terminals.closeWorkspace(workspace);
				return null;
			},
		};
	});
	// Held while the plugin is loaded, so a terminal outlives its viewers and the plugins showing it.
	contribute(host, "environments.terminals-keep", (self) => void self.get(TerminalKeeper, {}));

	host.serve(TerminalList, (owner, self) => {
		// Held, so the host is there; read when the object opens, after the keeper contributed it.
		self.get(TerminalKeeper, {});
		const terminals = self.registry(TerminalHosts);
		const list = self.writable<TerminalRow[]>([]);
		self.open(
			async () => {
				const at = terminals.value;
				list.set(at?.list(owner) ?? []);
				return at?.watch(owner, (rows) => list.set(rows));
			},
			(stop) => stop?.(),
		);
		return { terminals: self.derive([list], ([rows]) => rows) };
	});
}

/** How many terminals one host runs at most, over every owner (opens under way counted). */
const MAX_HOSTED = 100;

/**
 * A running or ended terminal: its row, owner, program (none once it exited), size, output, who waits for more and who
 * follows its size.
 */
type Hosted = {
	row: TerminalRow;
	readonly owner: TerminalOwner;
	/** The owner's key in the host's maps. */
	readonly key: string;
	pty: Pty | undefined;
	size: TerminalSize;
	readonly ring: Ring;
	readonly waiting: Set<() => void>;
	readonly sized: Set<(size: TerminalSize) => void>;
	closed: boolean;
};

/** How many ended terminals an owner keeps (with their output) until closed: the oldest go first. */
const ENDED_ROWS = 20;

/** How many bytes of ended terminals' output an owner keeps: the oldest go first. */
const ENDED_BYTES = 1024 * 1024;

/** An open under way: whose, on which machine, and how it is taken back (its own cancellation). */
type Pending = {
	readonly owner: TerminalOwner;
	readonly key: string;
	readonly machine: string;
	readonly cancel: () => void;
};

/** The empty list, one value. */
const NONE: TerminalRow[] = [];

/** The terminal host over the machines `hosts` resolves (read at each open). */
export class HostedTerminals implements TerminalHost {
	readonly #hosts: () => MachineHostResolver;
	readonly #terminals = new Map<string, Hosted>();
	/** Each owner's list, by the owner's key, with the owner it is of. */
	readonly #lists = new Map<string, { readonly owner: TerminalOwner; readonly rows: TerminalRow[] }>();
	readonly #watchers = new Map<string, Set<(rows: TerminalRow[]) => void>>();
	readonly #pending = new Set<Pending>();
	#ended = false;

	constructor(hosts: () => MachineHostResolver) {
		this.#hosts = hosts;
	}

	list(owner: TerminalOwner): TerminalRow[] {
		return this.#rows(keyOf(owner));
	}

	watch(owner: TerminalOwner, listener: (rows: TerminalRow[]) => void): () => void {
		const key = keyOf(owner);
		const listeners = this.#watchers.get(key) ?? new Set();
		this.#watchers.set(key, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && this.#watchers.get(key) === listeners) this.#watchers.delete(key);
		};
	}

	owners(): TerminalOwner[] {
		return [...this.#lists.values()].map(({ owner }) => owner);
	}

	async open(request: TerminalRequest, context: Context): Promise<string> {
		const { owner, machine, folder, columns, rows, max } = request;
		const key = keyOf(owner);
		if (this.#ended) throw notHere(machine);
		if (this.#running(key) >= max || this.#running(undefined) >= MAX_HOSTED) {
			throw forbidden(`environments: too many terminals for ${key}`, { message: messages.message("tooMany") });
		}
		// The slot is taken before the first await, so two opens cannot both pass the count; the open's own
		// cancellation is what an end of the host, the machine or the owner takes it back with.
		const { context: starting, cancel } = withCancel(context);
		const pending: Pending = { owner, key, machine, cancel };
		this.#pending.add(pending);
		const id = crypto.randomUUID();
		const hosted: Hosted = {
			row: { id, machine, folder, exitCode: null },
			owner,
			key,
			pty: undefined,
			size: { columns, rows },
			ring: new Ring(TERMINAL_BACKLOG),
			waiting: new Set(),
			sized: new Set(),
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
			const at = await this.#hosts()(machine, starting);
			if (at === undefined) throw notHere(machine);
			if (starting.abortSignal?.aborted) throw takenBack(id);
			const opened = await at.openPty({ cwd: folder, columns, rows, onData }, starting);
			if (starting.abortSignal?.aborted) {
				if (opened.ok) opened.value.close();
				throw takenBack(id);
			}
			if (!opened.ok) throw ptyRefused(opened.error);
			pty = opened.value;
		} finally {
			this.#pending.delete(pending);
		}
		hosted.pty = pty;
		this.#terminals.set(id, hosted);
		this.#publish(owner, key, [...this.#rows(key), hosted.row]);
		void pty.exited.then((exitCode) => {
			if (hosted.closed) return;
			// An ended program keeps its row and output until closed; its pseudo-terminal is released now.
			pty.close();
			hosted.pty = undefined;
			this.#change(hosted, { ...hosted.row, exitCode });
			wake(hosted);
			this.#trimEnded(key);
		});
		return id;
	}

	write(id: string, data: string | Uint8Array): boolean {
		const pty = this.#terminals.get(id)?.pty;
		pty?.write(data);
		return pty !== undefined;
	}

	resize(id: string, columns: number, rows: number): void {
		const hosted = this.#terminals.get(id);
		if (hosted?.pty === undefined) return;
		if (hosted.size.columns === columns && hosted.size.rows === rows) return;
		hosted.pty.resize(columns, rows);
		const size = { columns, rows };
		hosted.size = size;
		for (const listener of [...hosted.sized]) listener(size);
	}

	followSize(id: string, listener: (size: TerminalSize) => void): () => void {
		const hosted = this.#terminals.get(id);
		if (hosted === undefined) return () => {};
		hosted.sized.add(listener);
		listener(hosted.size);
		return () => hosted.sized.delete(listener);
	}

	close(id: string): void {
		const hosted = this.#terminals.get(id);
		if (hosted === undefined) return;
		hosted.closed = true;
		hosted.pty?.close();
		hosted.pty = undefined;
		hosted.sized.clear();
		this.#terminals.delete(id);
		this.#publish(
			hosted.owner,
			hosted.key,
			this.#rows(hosted.key).filter((row) => row.id !== id),
		);
		wake(hosted);
	}

	closeThing(thing: string): void {
		for (const pending of this.#pending) if (pending.owner.thing === thing) pending.cancel();
		for (const [id, hosted] of this.#terminals) if (hosted.owner.thing === thing) this.close(id);
	}

	closeWorkspace(workspace: string): void {
		for (const pending of this.#pending) if (pending.owner.workspace === workspace) pending.cancel();
		for (const [id, hosted] of this.#terminals) if (hosted.owner.workspace === workspace) this.close(id);
	}

	closeMachine(machine: string): void {
		for (const pending of this.#pending) if (pending.machine === machine) pending.cancel();
		for (const [id, hosted] of this.#terminals) if (hosted.row.machine === machine) this.close(id);
	}

	tail(id: string, max: number): { readonly end: number; readonly bytes: Uint8Array } {
		const ring = this.#terminals.get(id)?.ring;
		if (ring === undefined) return { end: 0, bytes: new Uint8Array() };
		const length = Math.min(max, TERMINAL_BACKLOG);
		return { end: ring.end, bytes: ring.read(ring.end - length, length) };
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
		for (const pending of this.#pending) pending.cancel();
		for (const id of [...this.#terminals.keys()]) this.close(id);
	}

	/** The list of the owner with key `key`. */
	#rows(key: string): TerminalRow[] {
		return this.#lists.get(key)?.rows ?? NONE;
	}

	/** Lets the oldest ended terminals of the owner `key` go while it keeps more than `ENDED_ROWS` or `ENDED_BYTES`. */
	#trimEnded(key: string): void {
		const ended: Hosted[] = [];
		let bytes = 0;
		for (const { id, exitCode } of this.#rows(key)) {
			const hosted = this.#terminals.get(id);
			if (hosted === undefined || exitCode === null) continue;
			ended.push(hosted);
			bytes += hosted.ring.size;
		}
		let kept = ended.length;
		for (const oldest of ended) {
			if (kept <= ENDED_ROWS && bytes <= ENDED_BYTES) return;
			this.close(oldest.row.id);
			kept--;
			bytes -= oldest.ring.size;
		}
	}

	/** How many programs run (opens under way included): the owner `key`'s, or every owner's (`undefined`). */
	#running(key: string | undefined): number {
		let running = 0;
		for (const pending of this.#pending) if (key === undefined || pending.key === key) running++;
		for (const hosted of this.#terminals.values()) {
			if (hosted.row.exitCode === null && (key === undefined || hosted.key === key)) running++;
		}
		return running;
	}

	/** Replaces `hosted`'s row with `row` in its owner's list. */
	#change(hosted: Hosted, row: TerminalRow): void {
		const old = hosted.row;
		hosted.row = row;
		this.#publish(
			hosted.owner,
			hosted.key,
			this.#rows(hosted.key).map((each) => (each === old ? row : each)),
		);
	}

	/** Makes `rows` the list of `owner` (key `key`) and tells its watchers. */
	#publish(owner: TerminalOwner, key: string, rows: TerminalRow[]): void {
		if (rows.length === 0) this.#lists.delete(key);
		else this.#lists.set(key, { owner, rows });
		for (const listener of this.#watchers.get(key) ?? []) listener(rows.length === 0 ? NONE : rows);
	}
}

/** An owner's key in the host's maps (ids hold no newline). */
function keyOf({ thing, workspace }: TerminalOwner): string {
	return `${thing}\n${workspace}`;
}

/** The refusal of a machine that is not there (gone, or its type not installed). */
function notHere(machine: string) {
	return forbidden(`environments: machine ${machine} runs no terminals here`, {
		message: messages.message("notHere"),
	});
}

/** The refusal of an open taken back while it started (by its caller, or the end of its host, machine or owner). */
function takenBack(id: string) {
	return forbidden(`environments: terminal ${id} closed while it started`, { message: messages.message("notHere") });
}

/** The refusal of a machine that could not start a program: it has no terminals (`not_supported`), or it failed. */
function ptyRefused(error: FileError) {
	const message =
		error.code === "not_supported" ? messages.message("noTerminals") : messages.message("ptyFailed", error.message);
	return forbidden(`environments: no terminal: ${error.message}`, { message });
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
