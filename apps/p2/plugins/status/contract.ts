import type { Usage } from "@earendil-works/pi-ai";
import { arr, bool, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { local, method, param, record, remote, serverHost, unsafe } from "@p2/app/v1";

export const StatusSchema = obj({
	/** A worker process runs for the session. */
	running: bool(),
	error: opt(str()),
	usage: opt(unsafe<Usage>(unknown())),
	/** Live Durable tasks (foreground and background). */
	tasks: num(),
	/** Conversations with foreground work, ascending. */
	busy: arr(num()),
});
export type Status = Static<typeof StatusSchema>;
export const StatusesSchema = record(StatusSchema);

const report = {
	tasks: num(),
	busy: arr(num()),
	usage: opt(unsafe<Usage>(unknown())),
};
const ReportSchema = obj(report);

/** Live status of every session (server, in memory). Reports are fenced by worker generation. */
export const StatusStore = local("p2.status-store", {
	version: 1,
	params: {},
	members: {
		statuses: StatusesSchema,
		report: method(obj({ ...report, session: str(), generation: num() })),
	},
});

/** Readers (owner) see every session's status; a worker reports its own session's (its principal names it). */
export const SessionStatus = remote("p2.session-status", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { statuses: StatusesSchema } },
		reporter: { methods: { report: method(ReportSchema) } },
	},
});

/** Owner-only retry of a failed session worker; reading status never starts it. */
export const WorkerControl = remote("p2.worker-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: { owner: { methods: { restart: method() } } },
});

/** Browser pages hold one unique lease for their active session, including child views. */
export const Viewers = local("p2.session-viewers", {
	version: 1,
	params: {},
	members: {
		counts: record(num()),
		enter: method(obj({ session: str(), viewer: str() })),
		leave: method(obj({ session: str(), viewer: str() })),
	},
});
export const SessionMetrics = remote("p2.session-metrics", {
	version: 1,
	params: { session: param.str(), viewer: param.str({ min: 1, max: 80 }) },
	hostAddress: serverHost,
	variants: {
		reader: {
			state: { clients: num(), usage: union([unsafe<Usage>(unknown()), nul()]) },
		},
	},
});
