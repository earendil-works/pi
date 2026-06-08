import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import type { SessionEntry } from "./session-manager.ts";
import type { EditOperations } from "./tools/edit.ts";
import { withFileMutationQueue } from "./tools/file-mutation-queue.ts";
import type { WriteOperations } from "./tools/write.ts";

/**
 * Custom session-entry types used by the checkpoint store. These are stored via
 * SessionManager.appendCustomEntry (type: "custom"), so they persist in the
 * session JSONL without entering the LLM context and without a schema migration.
 */
export const FILE_CHECKPOINT_TYPE = "file_checkpoint";
export const FILE_RESTORE_TYPE = "file_restore";
export const FILE_RESTORE_DONE_TYPE = "file_restore_done";

/** One file captured within a turn. */
export interface CheckpointFile {
	/** Path relative to the session cwd (display + reapply target). */
	path: string;
	/**
	 * Content hash of the file BEFORE pi first touched it this turn, or null if
	 * the file did not exist yet (so restoring it means deleting the file).
	 */
	before: string | null;
	/** Content hash of what pi last wrote to the file this turn (external-edit guard). */
	after: string | null;
}

/** Manifest persisted once per turn that mutated files. */
export interface FileCheckpointData {
	turnId: string;
	files: CheckpointFile[];
}

interface RestorePlanItem {
	path: string;
	/** absolute path resolved against cwd */
	absolutePath: string;
	action: "write" | "delete";
	/** blob hash to write back (action === "write") */
	before: string | null;
	/** expected on-disk hash for the external-edit guard */
	after: string | null;
}

interface RestoreMarkerData {
	targetTurnId: string;
	plan: RestorePlanItem[];
}

/** Result of a restore, surfaced to the user. */
export interface RestoreSummary {
	restored: string[];
	deleted: string[];
	/** files skipped because they were edited outside pi (bash / external editor) */
	skippedExternal: string[];
	/** files already at the target state */
	unchanged: number;
}

interface PendingCapture {
	relPath: string;
	absolutePath: string;
	before: string | null;
	after: string | null;
}

const ABSENT = null;

export interface FileCheckpointStoreOptions {
	sessionId: string;
	cwd: string;
	/** Root dir for checkpoint blobs, e.g. ~/.pi/agent/checkpoints */
	checkpointsRoot: string;
	/** Append a custom manifest entry to the session; returns its id. */
	appendCustomEntry: (customType: string, data: unknown) => string;
	/** Read all session entries (to rebuild manifests / recover restores). */
	getEntries: () => SessionEntry[];
	/** Walk root -> fromId, returning entries in order. */
	getBranch: (fromId: string) => SessionEntry[];
	/** Whether the agent is mid-run; restore is refused while true. */
	isStreaming: () => boolean;
}

/**
 * Captures the before-state of files pi edits (per user turn) and restores them
 * on rewind. Capture is content-addressed and deduped by sha256. Only files
 * written through pi's edit/write tools are tracked; changes made by raw bash
 * or external editors are NOT captured (and are guarded against on restore).
 */
export class FileCheckpointStore {
	private readonly sessionId: string;
	private readonly cwd: string;
	private readonly blobDir: string;
	private readonly appendCustomEntry: (customType: string, data: unknown) => string;
	private readonly getEntries: () => SessionEntry[];
	private readonly getBranch: (fromId: string) => SessionEntry[];
	private readonly isStreaming: () => boolean;

	private currentTurnId: string | null = null;
	/** captures for the current turn, keyed by mutation key (realpath) */
	private pending = new Map<string, PendingCapture>();
	private flushedTurns = new Set<string>();

	constructor(options: FileCheckpointStoreOptions) {
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.blobDir = resolve(options.checkpointsRoot, this.sessionId, "blobs");
		this.appendCustomEntry = options.appendCustomEntry;
		this.getEntries = options.getEntries;
		this.getBranch = options.getBranch;
		this.isStreaming = options.isStreaming;
	}

	/** Begin a new turn (a user message). Flushes the previous turn's manifest. */
	beginTurn(turnId: string | null): void {
		this.flushPending();
		this.currentTurnId = turnId;
		this.pending.clear();
	}

	/**
	 * Persist the current turn's manifest entry if anything was captured.
	 * Idempotent: a turn is only flushed once.
	 */
	flushPending(): void {
		const turnId = this.currentTurnId;
		if (!turnId || this.pending.size === 0 || this.flushedTurns.has(turnId)) {
			this.pending.clear();
			return;
		}
		const files: CheckpointFile[] = [...this.pending.values()].map((p) => ({
			path: p.relPath,
			before: p.before,
			after: p.after,
		}));
		const data: FileCheckpointData = { turnId, files };
		this.appendCustomEntry(FILE_CHECKPOINT_TYPE, data);
		this.flushedTurns.add(turnId);
		this.pending.clear();
	}

	/** Wrap the edit tool's file operations so writes capture before-state. */
	wrapEditOperations(): EditOperations {
		return {
			readFile: (path) => Promise.resolve(readFileSync(path)),
			access: (path) => {
				// Throw if not readable+writable, matching the default edit operations.
				accessSync(path, constants.R_OK | constants.W_OK);
				return Promise.resolve();
			},
			writeFile: (path, content) => this.captureAndWrite(path, content),
		};
	}

	/** Wrap the write tool's file operations so writes capture before-state. */
	wrapWriteOperations(): WriteOperations {
		return {
			mkdir: (dir) => {
				mkdirSync(dir, { recursive: true });
				return Promise.resolve();
			},
			writeFile: (path, content) => this.captureAndWrite(path, content),
		};
	}

	/**
	 * Capture the file's current content (once per turn), then write the new
	 * content. Runs inside the tool's per-file mutation lock, so the read sees a
	 * consistent baseline.
	 *
	 * The after-hash is recorded only after the write succeeds: a failed write
	 * must not leave a manifest claiming pi wrote content it never did (that would
	 * make the external-edit guard wrongly skip a legitimate restore). If the
	 * write throws on first touch, the just-added capture is rolled back so no
	 * phantom entry is persisted.
	 */
	private async captureAndWrite(absolutePath: string, content: string): Promise<void> {
		const key = mutationKey(absolutePath);
		const newlyCaptured = this.captureBefore(absolutePath, key);
		try {
			writeFileSync(absolutePath, content, "utf-8");
		} catch (error) {
			if (newlyCaptured) this.pending.delete(key);
			throw error;
		}
		this.recordAfter(key, hashContent(content));
	}

	/** Returns true if this call inserted a new capture for the turn. */
	private captureBefore(absolutePath: string, key: string): boolean {
		// Capture is deduped by realpath (mutationKey), so distinct symlinks
		// pointing at the same file collapse to one manifest entry per turn.
		if (!this.currentTurnId || this.pending.has(key)) return false;
		let before: string | null;
		try {
			before = this.writeBlob(readFileSync(absolutePath));
		} catch (error) {
			if (isMissingFile(error)) {
				before = ABSENT;
			} else {
				throw error;
			}
		}
		this.pending.set(key, {
			relPath: relative(this.cwd, absolutePath),
			absolutePath,
			before,
			after: null,
		});
		return true;
	}

	private recordAfter(key: string, afterHash: string): void {
		const entry = this.pending.get(key);
		if (entry) entry.after = afterHash;
	}

	// === Restore ===

	/**
	 * Restore files to their state before `targetTurnId`, rolling back every turn
	 * on the path from `fromLeafId` down to (and including) the target turn.
	 * Must be called BEFORE navigating the conversation, with the pre-navigation
	 * leaf id, so the abandoned path is still reachable.
	 */
	async restoreTo(targetTurnId: string, fromLeafId: string): Promise<RestoreSummary> {
		if (this.isStreaming()) {
			throw new Error("Cannot restore files while the agent is running");
		}
		this.flushPending();

		const plan = this.buildPlan(targetTurnId, fromLeafId);
		const summary: RestoreSummary = { restored: [], deleted: [], skippedExternal: [], unchanged: 0 };
		if (plan.length === 0) return summary;

		// Forensic + crash-recovery marker, written before any disk mutation.
		this.appendCustomEntry(FILE_RESTORE_TYPE, {
			targetTurnId,
			plan,
		} satisfies RestoreMarkerData);

		await this.applyPlan(plan, summary);

		this.appendCustomEntry(FILE_RESTORE_DONE_TYPE, { targetTurnId });
		return summary;
	}

	/** Compute the restore plan: earliest before-state wins, latest after-state guards. */
	private buildPlan(targetTurnId: string, fromLeafId: string): RestorePlanItem[] {
		const manifests = this.collectManifests();
		const path = this.getBranch(fromLeafId);
		const targetIndex = path.findIndex((e) => e.id === targetTurnId);
		if (targetIndex === -1) return [];
		const idsInRange = new Set(path.slice(targetIndex).map((e) => e.id));

		// Walk turns from target forward so the first occurrence of a file is its
		// state before the target turn; the last occurrence is what pi last wrote.
		const byPath = new Map<string, RestorePlanItem>();
		for (const entry of path.slice(targetIndex)) {
			const manifest = manifests.get(entry.id);
			if (!manifest) continue;
			for (const file of manifest.files) {
				const absolutePath = resolve(this.cwd, file.path);
				const existing = byPath.get(file.path);
				if (existing) {
					existing.after = file.after; // latest write wins for the guard
				} else {
					byPath.set(file.path, {
						path: file.path,
						absolutePath,
						action: file.before === ABSENT ? "delete" : "write",
						before: file.before,
						after: file.after,
					});
				}
			}
		}
		// idsInRange is implied by the slice above; kept for clarity/debugging.
		void idsInRange;
		return [...byPath.values()];
	}

	private async applyPlan(plan: RestorePlanItem[], summary: RestoreSummary): Promise<void> {
		for (const item of plan) {
			await withFileMutationQueue(item.absolutePath, async () => {
				const currentHash = this.currentDiskHash(item.absolutePath);

				// Already at the target state -> nothing to do.
				const targetHash = item.before; // null means "should not exist"
				if (currentHash === targetHash) {
					summary.unchanged++;
					return;
				}

				// External-edit guard: only touch files that are exactly as pi last
				// left them. Otherwise the user changed them outside pi (bash /
				// editor) and we must not clobber that work.
				if (item.after !== null && currentHash !== item.after) {
					summary.skippedExternal.push(item.path);
					return;
				}
				if (item.after === null && currentHash !== null) {
					// pi's record says it never wrote content, but a file exists now.
					summary.skippedExternal.push(item.path);
					return;
				}

				if (item.action === "delete") {
					if (currentHash !== null) {
						rmSync(item.absolutePath, { force: true });
					}
					summary.deleted.push(item.path);
				} else if (item.before !== null) {
					const content = this.readBlob(item.before);
					mkdirSync(resolve(item.absolutePath, ".."), { recursive: true });
					writeFileSync(item.absolutePath, content);
					summary.restored.push(item.path);
				}
			});
		}
	}

	/**
	 * Re-drive an incomplete restore (process crashed mid-restore). Idempotent:
	 * writing the same blob twice is a no-op. Returns a summary if it ran.
	 */
	async recoverIncompleteRestore(): Promise<RestoreSummary | null> {
		const entries = this.getEntries();
		let pendingMarker: RestoreMarkerData | null = null;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === FILE_RESTORE_TYPE) {
				pendingMarker = entry.data as RestoreMarkerData;
			} else if (entry.customType === FILE_RESTORE_DONE_TYPE) {
				pendingMarker = null; // matched completion
			}
		}
		if (!pendingMarker || pendingMarker.plan.length === 0) return null;

		const summary: RestoreSummary = { restored: [], deleted: [], skippedExternal: [], unchanged: 0 };
		await this.applyPlan(pendingMarker.plan, summary);
		this.appendCustomEntry(FILE_RESTORE_DONE_TYPE, { targetTurnId: pendingMarker.targetTurnId });
		return summary;
	}

	// === blob store ===

	private collectManifests(): Map<string, FileCheckpointData> {
		const map = new Map<string, FileCheckpointData>();
		for (const entry of this.getEntries()) {
			if (entry.type === "custom" && entry.customType === FILE_CHECKPOINT_TYPE) {
				const data = entry.data as FileCheckpointData;
				map.set(data.turnId, data); // later manifest for same turn wins
			}
		}
		return map;
	}

	private writeBlob(content: Buffer): string {
		const hash = hashBuffer(content);
		const blobPath = resolve(this.blobDir, hash);
		if (!existsSync(blobPath)) {
			mkdirSync(this.blobDir, { recursive: true });
			writeFileSync(blobPath, content);
		}
		return hash;
	}

	private readBlob(hash: string): Buffer {
		return readFileSync(resolve(this.blobDir, hash));
	}

	private currentDiskHash(absolutePath: string): string | null {
		try {
			return hashBuffer(readFileSync(absolutePath));
		} catch (error) {
			if (isMissingFile(error)) return null;
			throw error;
		}
	}
}

/**
 * Remove all checkpoint blobs for a session. Call this when a session is
 * deleted so its captured file contents don't linger on disk.
 */
export function deleteSessionCheckpoints(sessionId: string, checkpointsRoot: string): void {
	rmSync(resolve(checkpointsRoot, sessionId), { recursive: true, force: true });
}

function hashBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function hashContent(content: string): string {
	return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code: string }).code === "ENOENT" || (error as { code: string }).code === "ENOTDIR")
	);
}

/**
 * Stable key for a file mutation, mirroring file-mutation-queue's keying so
 * capture and the tool's lock agree. Resolves symlinks when the file exists,
 * falls back to the absolute path otherwise (new files).
 */
function mutationKey(filePath: string): string {
	const resolved = resolve(filePath);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isMissingFile(error)) return resolved;
		throw error;
	}
}
