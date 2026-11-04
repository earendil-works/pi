// The supervisor's pi-env connections to environments: one per environment and configuration revision, shared by every
// instance running there and closed with the last one. A connection lost meanwhile starts again at its next request
// (pi-env); the daemon killed the programs it ran, and their instances reconnect.

import type { Connection } from "@earendil-works/pi-env";
import { envRevision } from "@p2/app/v1/node";
import type { EnvConfig } from "../envs/config.ts";

/** A connection to environment `name` configured as `config`, which starts at its first request. */
export type ConnectEnv = (name: string, config: EnvConfig) => Connection;

/** One instance's use of an environment's connection; released once, when the instance closes. */
export type EnvLease = { readonly connection: Connection; release(): void };

/** The open connections by environment and revision, with how many instances use each. */
export class EnvConnections {
	readonly #connect: ConnectEnv;
	readonly #open = new Map<string, { readonly connection: Connection; users: number }>();

	constructor(connect: ConnectEnv) {
		this.#connect = connect;
	}

	/** The connection to `name` as configured now (opened for its first user); release it once done. */
	acquire(name: string, config: EnvConfig): EnvLease {
		const key = JSON.stringify([name, envRevision(config)]);
		let entry = this.#open.get(key);
		if (entry === undefined) {
			entry = { connection: this.#connect(name, config), users: 0 };
			this.#open.set(key, entry);
		}
		const used = entry;
		used.users++;
		return {
			connection: used.connection,
			release: () => {
				used.users--;
				if (used.users > 0) return;
				this.#open.delete(key);
				used.connection.close();
			},
		};
	}
}
