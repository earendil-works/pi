// Dev controls: Chord's plugin watcher marks dirty plugins only; owners and agents explicitly choose when to apply
// changes (Reload), and a changed module of the running server asks for a restart.
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { Plugins } from "@earendil-works/chord/plugins";
import type { DevResult, DevStatus } from "../runtime/dev-protocol.ts";
import { processLogs } from "../runtime/logs.ts";
import type { LoadedModules } from "./dev-modules.ts";

export type { DevStatus } from "../runtime/dev-protocol.ts";

/**
 * The dev state over `plugins.state` (dirty plugins, from Chord's watcher: a facet's file, a file one of its facets
 * read, or a web/TUI file in its directory; plugins added or removed) and `loadedModules` (server modules whose
 * content changed: restart). `reload(names)` applies the named (default: dirty) plugins through the app's `reload`.
 */
export function devControl<T>(options: {
	readonly plugins: Plugins;
	readonly reload: (plugins: readonly string[]) => Promise<{ plugins: readonly string[]; value: T }>;
	readonly runtimeDirectory: string;
	readonly loadedModules?: LoadedModules;
	/** The plugins added or removed since the last reload: what a changed plugin set (`state.set`) names. */
	readonly setChanges: () => readonly string[];
}) {
	let status: DevStatus = {
		revision: 0,
		phase: "idle",
		plugins: [],
		dirty: [],
		restartNeeded: false,
		restartFiles: [],
	};
	let active: Promise<T> | undefined;
	let closed = false;
	const dirty = (): string[] => {
		const state = options.plugins.state.value;
		return [...new Set([...state.dirty, ...state.install, ...(state.set ? options.setChanges() : [])])].sort();
	};
	const update = (change: Partial<DevStatus>): void => {
		status = { ...status, ...change, revision: status.revision + 1, dirty: dirty() };
	};
	const notify = (result: DevResult): void => {
		const message = processLogs.redactor.redact(result.message);
		update({
			phase: result.ok ? "ready" : "error",
			plugins: result.plugins ?? [],
			message,
			noticeId: randomUUID(),
			noticeTime: Date.now(),
		});
		console[result.ok ? "log" : "error"](`p2 dev: ${message}`);
	};
	return {
		status: (): DevStatus => {
			if (JSON.stringify(dirty()) !== JSON.stringify(status.dirty)) update({});
			// Poll content, not events: this also covers workspace sources, deletions and exact-content reverts.
			const restartFiles = (options.loadedModules?.changed() ?? []).map((file) =>
				relative(options.runtimeDirectory, file),
			);
			if (JSON.stringify(restartFiles) !== JSON.stringify(status.restartFiles))
				update({ restartNeeded: restartFiles.length > 0, restartFiles });
			return status;
		},
		notify,
		reload: async (requested?: readonly string[]): Promise<T> => {
			if (closed) throw new Error("Dev server is closing");
			if (active) {
				const error = new Error("A dev command is already running");
				notify({ ok: false, message: `Reload refused: ${error.message}` });
				throw error;
			}
			const names = requested?.length ? [...requested] : dirty();
			update({ phase: "reloading" });
			active = (async () => {
				try {
					const result = await options.reload(names);
					notify({
						ok: true,
						plugins: result.plugins,
						message: result.plugins.length ? `Reloaded ${result.plugins.join(", ")}` : "No dirty plugins",
					});
					return result.value;
				} catch (error) {
					notify({
						ok: false,
						plugins: names,
						message: `Reload refused: ${error instanceof Error ? error.message : String(error)}`,
					});
					throw error;
				}
			})();
			try {
				return await active;
			} finally {
				active = undefined;
			}
		},
		close: async (): Promise<void> => {
			closed = true;
			await active?.catch(() => {});
		},
	};
}
