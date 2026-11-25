// The contracts of example 76: the session kind, what a session's worker reports to the server, and the test's
// handle on the worker.

import { hostKind, method, remote, str } from "../../../src/contracts/index.ts";

export const Server = hostKind("server");

export const Session = hostKind("session", { id: str() });

/** On the server: what its workers report. */
export const Reports = remote("example.reports", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	methods: { report: method(str()) },
});

/** On a session's worker: makes it report, or report and exit in the same turn. */
export const Probe = remote("example.probe", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Session({ id }),
	methods: { report: method(str()), reportAndExit: method(str()) },
});
