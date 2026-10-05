import { createHash } from "node:crypto";
import { type FSWatcher, watch as fsWatch, type Stats } from "node:fs";
import { lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "./index.ts";

/** How `NodeExecutionEnv` watches. */
export interface NodeWatchOptions {
	/**
	 * Force a mode. By default `polling` is chosen on Windows, where native watchers keep directories open and so block
	 * renaming their parents, and for file systems that do not report remote changes.
	 */
	mode?: "native" | "polling";
	/** Interval between snapshots in `polling` mode; default 2000 ms. */
	pollIntervalMs?: number;
	/** Most directories one watcher covers; default 10,000. */
	maxDirectories?: number;
}

type ResolvedTarget = {
	readonly path: string;
	readonly recursive: boolean;
	readonly hidden: boolean;
	readonly names: ReadonlySet<string>;
};

/** What a snapshot remembers of one path. Directories and ancestors are compared by identity only. */
type Entry = {
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly hash?: string;
};

type Snapshot = Map<string, Entry>;

const DEBOUNCE_MS = 50;
/**
 * On macOS, `fs.watch` returns before libuv's FSEvents stream is live, and changes in between are never reported
 * (about 2% of changes made right after the call, none after 100 ms). A rescan this long after installing watchers
 * catches them.
 */
const FSEVENTS_SETTLE_MS = 500;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_DIRECTORIES = 10_000;
/** In polling mode, recently modified small files are also compared by content: a second write within the file system's
 * timestamp granularity can keep size and modification time. */
const HASH_MAX_BYTES = 256 * 1024;
const HASH_RECENT_MS = 5000;

/** Linux `statfs` magic numbers of file systems that accept watches but do not report changes made elsewhere. */
const UNRELIABLE_FILE_SYSTEMS = new Set([
	0x6969, // NFS
	0x517b, // SMB
	0xff534d42, // CIFS
	0xfe534d42, // SMB2
	0x65735546, // FUSE (sshfs, Android shared storage)
	0x01021997, // 9P (WSL2 Windows drives)
	0x0bd00bd0, // Lustre
	0x47504653, // GPFS
	0x00c36400, // Ceph
	0x5346414f, // OpenAFS
	0x6b414653, // kAFS
	0x5dca2df5, // sdcardfs
]);

class BudgetExceeded extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function entryOf(stats: Stats, hash?: string): Entry {
	const kind = stats.isFile()
		? "file"
		: stats.isDirectory()
			? "directory"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return {
		kind,
		dev: stats.dev,
		ino: stats.ino,
		size: kind === "directory" ? 0 : stats.size,
		mtimeMs: kind === "directory" ? 0 : stats.mtimeMs,
		...(hash === undefined ? {} : { hash }),
	};
}

function sameEntry(a: Entry, b: Entry): boolean {
	return (
		a.kind === b.kind &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.hash === b.hash
	);
}

/** Ancestors of `path`, nearest first, up to the root. */
function ancestorsOf(path: string): string[] {
	const result: string[] = [];
	for (let current = dirname(path); ; current = dirname(current)) {
		result.push(current);
		if (dirname(current) === current) return result;
	}
}

/** Whether `path` is `ancestor` or below it. */
function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function excluded(target: ResolvedTarget, name: string): boolean {
	return (target.hidden && name.startsWith(".")) || target.names.has(name);
}

/**
 * Watches by snapshots: native events only trigger a debounced rescan, and changes are the difference between
 * snapshots plus the event paths. A replaced file, a renamed or recreated ancestor, or a directory created with its
 * contents therefore never depends on which events an operating system sends. New directories get their watchers
 * before they are scanned again, so nothing written into them before the watcher existed is missed.
 */
export class NodeFileWatcher implements FileWatcher {
	readonly #targets: readonly ResolvedTarget[];
	readonly #onChange: (change: WatchChange) => void;
	readonly #pollIntervalMs: number;
	readonly #maxDirectories: number;
	readonly #watchers = new Map<string, FSWatcher>();
	readonly #events = new Set<string>();
	#mode: "native" | "polling";
	#snapshot: Snapshot = new Map();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#dirty = false;
	#closed = false;

	private constructor(
		targets: readonly ResolvedTarget[],
		onChange: (change: WatchChange) => void,
		mode: "native" | "polling",
		options: NodeWatchOptions,
	) {
		this.#targets = targets;
		this.#onChange = onChange;
		this.#mode = mode;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
		this.#maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	}

	/** Establish coverage: watchers first, then the snapshot later changes are compared with. */
	static async open(
		targets: readonly WatchTarget[],
		resolvePath: (path: string) => string,
		onChange: (change: WatchChange) => void,
		options: NodeWatchOptions,
	): Promise<NodeFileWatcher> {
		const resolved = targets.map((target) => ({
			path: resolvePath(target.path),
			recursive: target.recursive === true,
			hidden: target.exclude?.hidden === true,
			names: new Set(target.exclude?.names ?? []),
		}));
		// Windows refuses to rename a directory while another directory below it is open, and a native watcher keeps
		// every watched directory open: watching would break renames of their parents, so Windows polls.
		const mode =
			options.mode ??
			(process.platform === "win32" || (await anyUnreliable(resolved.map((target) => target.path)))
				? "polling"
				: "native");
		const watcher = new NodeFileWatcher(resolved, onChange, mode, options);
		try {
			await watcher.#sync(false);
		} catch (error) {
			watcher.#stop();
			if (error instanceof BudgetExceeded) throw new FileError("invalid", error.message);
			throw error;
		}
		watcher.#schedulePoll();
		return watcher;
	}

	get mode(): "native" | "polling" {
		return this.#mode;
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#stop();
		await this.#running;
	}

	#stop(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = undefined;
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
	}

	#deliver(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#onChange(change);
		} catch {
			// A throwing callback must not stop watching.
		}
	}

	#schedulePoll(): void {
		if (this.#closed || this.#mode !== "polling") return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush().finally(() => this.#schedulePoll());
		}, this.#pollIntervalMs);
	}

	#scheduleFlush(): void {
		if (this.#closed || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush();
		}, DEBOUNCE_MS);
	}

	#scheduleSettle(): void {
		if (this.#closed) return;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = setTimeout(() => {
			this.#settleTimer = undefined;
			void this.#flush();
		}, FSEVENTS_SETTLE_MS);
	}

	#flush(): Promise<void> {
		if (this.#running !== undefined) {
			this.#dirty = true;
			return this.#running;
		}
		this.#running = (async () => {
			try {
				do {
					this.#dirty = false;
					const events = [...this.#events];
					this.#events.clear();
					const changed = await this.#sync(true);
					for (const path of events) changed.add(path);
					if (changed.size > 0) this.#deliver({ paths: [...changed].sort() });
				} while (this.#dirty && !this.#closed);
			} catch (error) {
				const fileError =
					error instanceof FileError
						? error
						: new FileError("invalid", error instanceof Error ? error.message : String(error));
				this.#deliver({ error: fileError });
				this.#stop();
			} finally {
				this.#running = undefined;
			}
		})();
		return this.#running;
	}

	/** Rescan, report differences, and install watchers for new directories, rescanning until none are new. */
	async #sync(report: boolean): Promise<Set<string>> {
		const changed = new Set<string>();
		for (let round = 0; round < 10 && !this.#closed; round++) {
			const next = await this.#scan();
			if (report) for (const path of this.#diff(this.#snapshot, next)) changed.add(path);
			this.#snapshot = next;
			if (this.#mode === "polling" || !this.#reconcileWatchers(next)) break;
			if (process.platform === "darwin") this.#scheduleSettle();
			// Something written into a new directory before its watcher existed shows up in the next round.
			report = true;
		}
		return changed;
	}

	#diff(previous: Snapshot, next: Snapshot): string[] {
		const changed: string[] = [];
		for (const [path, entry] of next) {
			const before = previous.get(path);
			if (before === undefined || !sameEntry(before, entry)) changed.push(this.#reported(path));
		}
		for (const path of previous.keys()) if (!next.has(path)) changed.push(this.#reported(path));
		return changed;
	}

	/** An ancestor that changed identity moved every target below it; report those targets. */
	#reported(path: string): string {
		if (this.#targets.some((target) => isWithin(path, target.path))) return path;
		return this.#targets.find((target) => isWithin(target.path, path))?.path ?? path;
	}

	async #scan(): Promise<Snapshot> {
		const snapshot: Snapshot = new Map();
		let directories = 0;
		const countDirectory = (): void => {
			if (++directories > this.#maxDirectories) {
				throw new BudgetExceeded(`Watched paths exceed ${this.#maxDirectories} directories`);
			}
		};
		const record = async (path: string, stats: Stats): Promise<void> => {
			let hash: string | undefined;
			if (
				this.#mode === "polling" &&
				stats.isFile() &&
				stats.size <= HASH_MAX_BYTES &&
				Date.now() - stats.mtimeMs < HASH_RECENT_MS
			) {
				hash = await readFile(path).then(
					(content) => createHash("sha256").update(content).digest("hex"),
					() => undefined,
				);
			}
			snapshot.set(path, entryOf(stats, hash));
		};
		const scanDirectory = async (target: ResolvedTarget, directory: string): Promise<void> => {
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (error) {
				if (isNodeError(error) && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code ?? "")) return;
				throw error;
			}
			for (const name of names) {
				if (excluded(target, name)) continue;
				const path = `${directory.endsWith(sep) ? directory : directory + sep}${name}`;
				if (snapshot.has(path)) continue;
				const stats = await lstat(path).catch(() => undefined);
				if (stats === undefined) continue;
				await record(path, stats);
				if (target.recursive && stats.isDirectory()) {
					countDirectory();
					await scanDirectory(target, path);
				}
			}
		};
		for (const target of this.#targets) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.has(ancestor)) continue;
				const stats = await lstat(ancestor).catch(() => undefined);
				// Identity only: an ancestor's own timestamps change with every unrelated sibling.
				if (stats !== undefined) snapshot.set(ancestor, { ...entryOf(stats), size: 0, mtimeMs: 0 });
			}
			// The target itself may be a symbolic link to what is watched; follow it.
			const stats = await stat(target.path).catch(() => undefined);
			if (stats === undefined) continue;
			await record(target.path, stats);
			if (stats.isDirectory()) {
				countDirectory();
				await scanDirectory(target, target.path);
			}
		}
		return snapshot;
	}

	/**
	 * Watch every existing ancestor of each target, each target directory, and on Linux each directory below a recursive
	 * target (elsewhere one recursive watcher per target). Returns whether a watcher was added.
	 */
	#reconcileWatchers(snapshot: Snapshot): boolean {
		const wanted = new Map<string, boolean>();
		const perDirectory = process.platform === "linux" || process.platform === "android";
		for (const target of this.#targets) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.get(ancestor)?.kind === "directory" && !wanted.has(ancestor)) wanted.set(ancestor, false);
			}
			if (snapshot.get(target.path)?.kind !== "directory") continue;
			const recursiveRoot = target.recursive && !perDirectory;
			wanted.set(target.path, recursiveRoot);
			if (target.recursive && perDirectory) {
				for (const [path, entry] of snapshot) {
					if (entry.kind === "directory" && path !== target.path && isWithin(path, target.path)) {
						wanted.set(path, false);
					}
				}
			}
		}
		for (const [path, watcher] of this.#watchers) {
			if (!wanted.has(path)) {
				watcher.close();
				this.#watchers.delete(path);
			}
		}
		let added = false;
		for (const [path, recursive] of wanted) {
			if (this.#watchers.has(path)) continue;
			try {
				const watcher = fsWatch(path, { recursive, persistent: false }, (_event, filename) =>
					this.#onEvent(path, filename === null ? undefined : String(filename)),
				);
				// A watched directory that disappears or fails: rescan, which also replaces the watcher.
				watcher.on("error", () => {
					watcher.close();
					if (this.#watchers.get(path) === watcher) this.#watchers.delete(path);
					this.#scheduleFlush();
				});
				this.#watchers.set(path, watcher);
				added = true;
			} catch (error) {
				// Out of watches or unsupported: compare snapshots from now on, and say coverage was uncertain.
				if (isNodeError(error) && error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM") {
					this.#switchToPolling();
					return false;
				}
			}
		}
		return added;
	}

	#switchToPolling(): void {
		if (this.#mode === "polling") return;
		this.#mode = "polling";
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		this.#deliver({ overflow: true });
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#schedulePoll();
	}

	#onEvent(directory: string, filename: string | undefined): void {
		if (this.#closed) return;
		const path =
			filename === undefined ? directory : `${directory.endsWith(sep) ? directory : directory + sep}${filename}`;
		// Events about unrelated siblings of an ancestor, or about excluded entries, are ignored.
		const relevant = this.#inScope(path);
		if (relevant) this.#events.add(this.#reported(path));
		if (relevant || filename === undefined) this.#scheduleFlush();
	}

	#inScope(path: string): boolean {
		for (const target of this.#targets) {
			if (isWithin(target.path, path)) return true;
			if (!isWithin(path, target.path) || path === target.path) continue;
			const components = relative(target.path, path).split(sep);
			if (!target.recursive && components.length > 1) continue;
			if (components.some((name) => excluded(target, name))) continue;
			return true;
		}
		return false;
	}
}

/** Whether any path, or its nearest existing ancestor, is on a file system that does not report remote changes. */
async function anyUnreliable(paths: readonly string[]): Promise<boolean> {
	if (process.platform !== "linux" && process.platform !== "android") return false;
	for (const path of paths) {
		for (const candidate of [path, ...ancestorsOf(path)]) {
			const info = await statfs(candidate).catch(() => undefined);
			if (info === undefined) continue;
			if (UNRELIABLE_FILE_SYSTEMS.has(info.type)) return true;
			break;
		}
	}
	return false;
}
