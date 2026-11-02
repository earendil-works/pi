// Fixture contracts (slice 10): the session kind the workers serve, the fixture worker's `Control` and its start data.

import { hostKind, int, method, remote, str } from "../../../../src/next/contracts/index.ts";

/** The host kind of the fixture workers. */
export const Session = hostKind("session", { id: str() });

/** What the fixture worker does on request, at its own address. */
export const Control = remote("test.control", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	variants: {
		main: {
			methods: {
				crash: method(int()),
				fatal: method(str()),
				block: method(int()),
				blockThenCrash: method(int()),
				busy: method(int()),
				localCalls: method(int(), int()),
			},
		},
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
	/** After its load: close its IPC channel and block, alive (the server must reap it). */
	readonly disconnectAndBlock?: boolean;
	/** 300 ms after its load: this many sequential local calls, then `local calls sent <n>` on stdout. */
	readonly localCalls?: number;
};
