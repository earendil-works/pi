// Fixture contracts (slice 10): the session kind the workers serve, the server's kind and the `Reports` it takes from
// its workers, the fixture worker's `Control` and its start data.

import { hostKind, int, method, remote, str } from "../../../../src/contracts/index.ts";

/** The host kind of the fixture workers. */
export const Session = hostKind("session", { id: str() });

/** The server's own kind. */
export const Server = hostKind("server");

/** What a worker reports to the server. */
export const Reports = remote("test.reports", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	methods: { report: method(str()) },
});

/** What the fixture worker does on request, at its own address. */
export const Control = remote("test.control", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	methods: {
		crash: method(int()),
		fatal: method(str()),
		block: method(int()),
		blockThenCrash: method(int()),
		busy: method(int()),
		localCalls: method(int(), int()),
		/** Sends the server a report and returns without waiting for its answer. */
		report: method(str()),
		/** Sends the server a report and exits (code 7) in the same turn. */
		reportAndExit: method(str()),
	},
});

/** The fixture worker's start data: how it behaves. */
export type WorkerBehaviour = {
	/** Exit with this code before connecting. */
	readonly exit?: number;
	/** Throw an error with this message before connecting (`fatal`, redacted: `secret…` words removed). */
	readonly fatal?: string;
	/** `false`: never connect (the start timer). */
	readonly connect?: boolean;
	/** Wait this long after connecting, before the load. */
	readonly loadMs?: number;
	/** Never load. */
	readonly hang?: boolean;
	/** A file the closers append their names to, in the order they run. */
	readonly log?: string;
	/** How long the second closer takes. */
	readonly closeMs?: number;
	/** A file a closer writes after its first import of a lazy module (`lazy-close.ts`), or the import's error code. */
	readonly lazyOnClose?: string;
	/** After its load: close its IPC channel and block, alive (the server must reap it). */
	readonly disconnectAndBlock?: boolean;
	/** 300 ms after its load: this many sequential local calls, then `local calls sent <n>` on stdout. */
	readonly localCalls?: number;
	/** After its load, before it is ready: sends the server this report and waits for its answer. */
	readonly reportAtStart?: string;
	/**
	 * Spawns a process that inherits its IPC channel: the channel stays open after the worker's exit, until the server
	 * killed its tree (so the server hears of the exit strictly before the channel closes).
	 */
	readonly holdsChannel?: boolean;
};
