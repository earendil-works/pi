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

/** What a worker reports of its work: its live tasks, its busy conversations and its spend. */
export const ReportFields = {
	tasks: num(),
	busy: arr(num()),
	usage: opt(unsafe<Usage>(unknown())),
};
const ReportSchema = obj(ReportFields);

/** Live status of every session (server, in memory). Reports are fenced by worker generation. */
export const StatusStore = local("p2.status-store", {
	version: 1,
	params: {},
	members: {
		statuses: StatusesSchema,
		report: method(obj({ ...ReportFields, session: str(), generation: num() })),
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

/**
 * The session worker's status push (worker, local): reports the worker's work now (its tasks, busy conversations and
 * spend) to the server and returns once the server committed it. A method that starts or stops work (`Chat.send`,
 * `Chat.stop`) awaits it, so the sidebar's working dot is current when the method answers.
 */
export const StatusReport = local("p2.status-report", {
	version: 1,
	params: {},
	members: { push: method() },
});

/**
 * Owner-only retry of a failed session worker; reading status never starts it. `restart` answers once the new worker
 * runs, or fails with why it could not start (`worker_failed`).
 */
export const WorkerControl = remote("p2.worker-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: { owner: { methods: { restart: method() } } },
});

/**
 * What a page shows about its session: how many viewers (distinct `viewer` params holding it: a page holds one for its
 * active session, child views included) and the session's spend.
 */
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
