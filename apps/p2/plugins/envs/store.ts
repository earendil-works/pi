import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Observer } from "@p2/app/v1/node";
import { type EnvsConfig, envsPath, loadEnvs } from "./config.ts";

export type EnvSnapshot = { configs: EnvsConfig; error: string | null };
/** Watch before loading. Invalid saves keep the last valid configuration. One observer per process. */
export class EnvStore {
	readonly observer: Observer;
	#snapshot: EnvSnapshot = { configs: {}, error: null };
	readonly #listeners = new Set<(snapshot: EnvSnapshot) => void>();
	constructor(directory: string) {
		this.observer = new Observer(
			[{ env: new NodeExecutionEnv({ cwd: directory }), targets: () => [{ path: envsPath(directory) }] }],
			async (retrying) => {
				try {
					this.#snapshot = { configs: await loadEnvs(directory), error: null };
				} catch {
					if (!retrying) return true;
					this.#snapshot = {
						configs: this.#snapshot.configs,
						error: "Could not load envs.json; keeping last valid state",
					};
				}
				for (const listener of this.#listeners) listener(this.#snapshot);
				return false;
			},
			2000,
		);
	}
	get snapshot(): EnvSnapshot {
		return this.#snapshot;
	}
	subscribe(listener: (snapshot: EnvSnapshot) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#snapshot);
		return () => this.#listeners.delete(listener);
	}
}
