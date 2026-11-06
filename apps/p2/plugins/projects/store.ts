// `projects.json` observed: every valid save applies at once, an invalid one keeps the last valid projects.
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Observer } from "@p2/app/v1/node";
import { loadProjects, projectsPath } from "./config.ts";
import type { Project } from "./contract.ts";

export type ProjectSnapshot = { projects: Project[]; error: string | null };

/** Watch before loading. Invalid saves keep the last valid projects and say why. One observer per process. */
export class ProjectStore {
	readonly observer: Observer;
	#snapshot: ProjectSnapshot = { projects: [], error: null };
	readonly #listeners = new Set<(snapshot: ProjectSnapshot) => void>();
	constructor(directory: string) {
		this.observer = new Observer(
			[{ env: new NodeExecutionEnv({ cwd: directory }), targets: () => [{ path: projectsPath(directory) }] }],
			async (retrying) => {
				try {
					this.#snapshot = { projects: await loadProjects(directory), error: null };
				} catch (error) {
					// An editor's save caught half-way: read once more before reporting it.
					if (!retrying) return true;
					const reason = error instanceof Error ? error.message : String(error);
					this.#snapshot = {
						projects: this.#snapshot.projects,
						error: `Could not load projects.json (${reason}); keeping the last valid projects`,
					};
				}
				for (const listener of this.#listeners) listener(this.#snapshot);
				return false;
			},
			2000,
		);
	}
	get snapshot(): ProjectSnapshot {
		return this.#snapshot;
	}
	/** `listener` hears of every load's snapshot from now on; the result stops it. */
	subscribe(listener: (snapshot: ProjectSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
