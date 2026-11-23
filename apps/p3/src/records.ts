// Who runs on a data directory: the server and its supervisor each hold a lock named after it while they live, and
// write a record beside it (`running.json`: pid, port, version, start time; `supervisor-running.json`: pid). A record counts
// only while its lock is held: a crash leaves the file, never the lock.

import { join } from "node:path";

/** What `running.json` holds while a server runs. */
export type ServerRecord = {
	readonly pid: number;
	readonly port: number;
	readonly version: string;
	/** When it listened, in ms since the epoch. */
	readonly startedAt: number;
};

/** The server's lock on `dataDir`: one server per data directory. */
export function serverLock(dataDir: string): string {
	return `p3-server:${dataDir}`;
}

/** The server's record in `dataDir`. */
export function serverFile(dataDir: string): string {
	return join(dataDir, "running.json");
}

/** The supervisor's lock on `dataDir`. */
export function supervisorLock(dataDir: string): string {
	return `p3-supervisor:${dataDir}`;
}

/** The supervisor's record in `dataDir`: its pid. */
export function supervisorFile(dataDir: string): string {
	return join(dataDir, "supervisor-running.json");
}
