/**
 * Local Pi runtime state storage.
 *
 * State is Pi-owned mutable bookkeeping. It is separate from user settings so
 * settings.json can stay shareable and dotfile-managed without app-written
 * values such as changelog acknowledgement state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";

/** Pi-owned local app state. Do not use this for user preferences. */
export interface State {
	lastChangelogVersion?: string;
}

/** Non-fatal state storage or legacy migration error collected for app-layer reporting. */
export interface StateError {
	source: "state" | "legacy-settings";
	error: Error;
}

interface StateStorage {
	withLock(fn: (current: string | undefined) => string | undefined): void;
}

class FileStateStorage implements StateStorage {
	constructor(private readonly filePath: string) {}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to keep the public state API synchronous.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire state lock");
	}

	withLock(fn: (current: string | undefined) => string | undefined): void {
		const dir = dirname(this.filePath);

		let release: (() => void) | undefined;
		try {
			const fileExists = existsSync(this.filePath);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(this.filePath);
			}
			const current = fileExists ? readFileSync(this.filePath, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(this.filePath);
				}
				writeFileSync(this.filePath, next, "utf-8");
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

class InMemoryStateStorage implements StateStorage {
	private value: string | undefined;

	withLock(fn: (current: string | undefined) => string | undefined): void {
		const next = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
	}
}

/**
 * Manages local Pi bookkeeping state.
 *
 * State is global to the agent directory, intentionally has no project override,
 * and must not be used for user preferences. Setters update in-memory state
 * synchronously and enqueue durable writes; call flush() when a caller needs a
 * persistence boundary.
 */
export class StateManager {
	private modifiedFields = new Set<keyof State>();
	private loadError: Error | null;
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: StateError[];

	private constructor(
		private readonly storage: StateStorage,
		private state: State,
		loadError: Error | null = null,
		initialErrors: StateError[] = [],
	) {
		this.loadError = loadError;
		this.errors = [...initialErrors];
	}

	/**
	 * Create a StateManager backed by agentDir/state.json.
	 *
	 * During startup this migrates legacy changelog acknowledgement from
	 * settings.json into state.json, then removes the legacy settings key once
	 * state is authoritative so user settings stay clean and shareable.
	 */
	static create(agentDir: string = getAgentDir()): StateManager {
		const storage = new FileStateStorage(join(agentDir, "state.json"));
		const legacySettingsStorage = new FileStateStorage(join(agentDir, "settings.json"));
		return StateManager.fromStorage(storage, legacySettingsStorage);
	}

	/** Create an in-memory StateManager with no file I/O. */
	static inMemory(state: State = {}): StateManager {
		const storage = new InMemoryStateStorage();
		storage.withLock(() => JSON.stringify(StateManager.normalizeState(state), null, 2));
		return StateManager.fromStorage(storage);
	}

	private static fromStorage(storage: StateStorage, legacySettingsStorage?: StateStorage): StateManager {
		const load = StateManager.tryLoadFromStorage(storage);
		const initialErrors: StateError[] = [];
		if (load.error) {
			initialErrors.push({ source: "state", error: load.error });
		}

		let state = load.state;
		if (!load.error && legacySettingsStorage) {
			const migration = StateManager.migrateLegacyLastChangelogVersion(storage, legacySettingsStorage, state);
			state = migration.state;
			initialErrors.push(...migration.errors);
		}

		return new StateManager(storage, state, load.error, initialErrors);
	}

	private static tryLoadFromStorage(storage: StateStorage): { state: State; error: Error | null } {
		try {
			return { state: StateManager.loadFromStorage(storage), error: null };
		} catch (error) {
			return { state: {}, error: StateManager.normalizeError(error) };
		}
	}

	private static loadFromStorage(storage: StateStorage): State {
		let content: string | undefined;
		storage.withLock((current) => {
			content = current;
			return undefined;
		});
		return StateManager.parseState(content);
	}

	private static migrateLegacyLastChangelogVersion(
		storage: StateStorage,
		legacySettingsStorage: StateStorage,
		loadedState: State,
	): { state: State; errors: StateError[] } {
		const errors: StateError[] = [];
		let state = structuredClone(loadedState);
		let authoritativeVersion = state.lastChangelogVersion;

		if (!authoritativeVersion) {
			const legacyRead = StateManager.readLegacyLastChangelogVersion(legacySettingsStorage);
			if (legacyRead.error) {
				errors.push({ source: "legacy-settings", error: legacyRead.error });
			}

			if (legacyRead.version) {
				const seed = StateManager.seedLastChangelogVersion(storage, legacyRead.version);
				if (seed.error) {
					errors.push({ source: "state", error: seed.error });
				} else {
					state = seed.state;
					authoritativeVersion = state.lastChangelogVersion;
				}
			}
		}

		if (authoritativeVersion) {
			const cleanupError = StateManager.removeLegacyLastChangelogVersion(legacySettingsStorage);
			if (cleanupError) {
				errors.push({ source: "legacy-settings", error: cleanupError });
			}
		}

		return { state, errors };
	}

	private static readLegacyLastChangelogVersion(storage: StateStorage): { version?: string; error?: Error } {
		let version: string | undefined;
		try {
			storage.withLock((current) => {
				const settings = StateManager.parseJsonObject(current);
				const legacyVersion = settings.lastChangelogVersion;
				if (typeof legacyVersion === "string") {
					version = legacyVersion;
				}
				return undefined;
			});
			return { version };
		} catch (error) {
			return { error: StateManager.normalizeError(error) };
		}
	}

	private static seedLastChangelogVersion(
		storage: StateStorage,
		version: string,
	): { state: State; error: Error | null } {
		let state: State | undefined;
		try {
			storage.withLock((current) => {
				const currentStateRecord = StateManager.parseJsonObject(current);
				const currentState = StateManager.stateFromRecord(currentStateRecord);
				if (currentState.lastChangelogVersion) {
					state = currentState;
					return undefined;
				}

				currentStateRecord.lastChangelogVersion = version;
				state = StateManager.stateFromRecord(currentStateRecord);
				return JSON.stringify(currentStateRecord, null, 2);
			});
			return { state: state ?? { lastChangelogVersion: version }, error: null };
		} catch (error) {
			return { state: {}, error: StateManager.normalizeError(error) };
		}
	}

	private static removeLegacyLastChangelogVersion(storage: StateStorage): Error | null {
		try {
			storage.withLock((current) => {
				if (!current) {
					return undefined;
				}

				const settings = StateManager.parseJsonObject(current);
				if (!Object.hasOwn(settings, "lastChangelogVersion")) {
					return undefined;
				}

				delete settings.lastChangelogVersion;
				return JSON.stringify(settings, null, 2);
			});
			return null;
		} catch (error) {
			return StateManager.normalizeError(error);
		}
	}

	private static parseState(content: string | undefined): State {
		return StateManager.stateFromRecord(StateManager.parseJsonObject(content));
	}

	private static stateFromRecord(record: Record<string, unknown>): State {
		const state: State = {};
		if (typeof record.lastChangelogVersion === "string") {
			state.lastChangelogVersion = record.lastChangelogVersion;
		}
		return state;
	}

	private static normalizeState(state: State): State {
		const normalized: State = {};
		if (typeof state.lastChangelogVersion === "string") {
			normalized.lastChangelogVersion = state.lastChangelogVersion;
		}
		return normalized;
	}

	private static parseJsonObject(content: string | undefined): Record<string, unknown> {
		if (!content) {
			return {};
		}

		const parsed = JSON.parse(content) as unknown;
		if (!StateManager.isRecord(parsed)) {
			return {};
		}
		return { ...parsed };
	}

	private static isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private static normalizeError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private recordError(source: StateError["source"], error: unknown): void {
		this.errors.push({ source, error: StateManager.normalizeError(error) });
	}

	private markModified(field: keyof State): void {
		this.modifiedFields.add(field);
	}

	private enqueueWrite(task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.modifiedFields.clear();
			})
			.catch((error) => {
				this.recordError("state", error);
			});
	}

	private persistState(snapshotState: State, modifiedFields: Set<keyof State>): void {
		this.storage.withLock((current) => {
			const currentState = StateManager.parseJsonObject(current);
			for (const field of modifiedFields) {
				const value = snapshotState[field];
				if (value === undefined) {
					delete currentState[field];
				} else {
					currentState[field] = value;
				}
			}

			return JSON.stringify(currentState, null, 2);
		});
	}

	private save(): void {
		if (this.loadError) {
			return;
		}

		const snapshotState = structuredClone(this.state);
		const modifiedFields = new Set(this.modifiedFields);
		this.enqueueWrite(() => {
			this.persistState(snapshotState, modifiedFields);
		});
	}

	getLastChangelogVersion(): string | undefined {
		return this.state.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.state.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	drainErrors(): StateError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}
}
