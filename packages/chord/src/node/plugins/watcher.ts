// The watcher and its marks (slice 7c §5, slice 12 §4): `fs.watch` on every directory of the plugin roots and the app's
// base code, `node_modules` and `.git` never watched (a directory appearing later gets its watch), marks what changed and
// never applies it. A changed file dirties every plugin whose facets used it (a copied contract every user), whose
// directory contains it or which is a single-file plugin of it; a changed `package.json` asks for an install (and for
// its metadata to be read again); a plugin directory, a facet file or a single-file plugin's file added or removed asks
// for discovery again. Base code is compared, not latched: `base` (the app restarts its hosts) is true exactly while a
// file differs from what a running base artifact read (its bytes' hash: the server's own code hashed at start, each
// base bundle's record), is gone, or is a source file new in a base directory; checked once when its watch starts and
// again at each event, the reads of one path in order. The marks are a JSON watchable; each plugin mark records the
// generation of its latest change (generations only increase), so a change during a build keeps its mark, however
// late an older build's rollout clears.

import {
	type Dirent,
	existsSync,
	type FSWatcher,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	watch,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import { type Batch, Source } from "../../state/internal.ts";
import { type BaseInputs, contentHash } from "./base-inputs.ts";
import { type BuiltFacet, inside } from "./build.ts";
import { type Discovery, FACET_EXTENSIONS, type Plugin, sameFiles } from "./discover.ts";

/** The marks: plugins to rebuild, plugins to install, whether to discover again, whether base code changed. */
export type PluginsState = {
	readonly dirty: readonly string[];
	readonly install: readonly string[];
	readonly set: boolean;
	readonly base: boolean;
};

/** The generation of each dirty plugin's latest change when a build started: what its rollout may clear. */
export type MarkSnapshot = { readonly plugins: ReadonlyMap<string, number> };

/** The generations of the latest change of the plugin set and of a `package.json` when a discovery started. */
export type DiscoverySnapshot = { readonly set: number; readonly manifest: number };

/** What the watcher watches and how it reports: the roots, the base code, the facet kinds, a failure to watch. */
export type WatcherOptions = {
	readonly roots: readonly string[];
	/** The server's own base code, files and directories: hashed when the watcher starts, the first base record. */
	readonly base: readonly string[];
	readonly kinds: readonly string[];
	/** The watcher cannot watch (the system's limit): reported once, after which the app builds on demand. */
	readonly failed: (error: unknown) => void;
};

/** Directories never watched, and changes under them never marked. */
const IGNORED = new Set(["node_modules", ".git"]);

/** The files of a base directory that are code: one added there marks `base` (a swap file or a note does not). */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"]);

/**
 * The watcher and the marks (`state`), a JSON watchable published at most once per microtask turn with changes. It
 * marks for the plugins of the last discovery (`know`) and the files their last builds read (`used`).
 */
export class PluginWatcher extends Source {
	readonly #options: WatcherOptions;
	readonly #roots: readonly string[];
	/** The base directories (watched as trees): a source file new in one marks `base`. */
	readonly #baseDirs: readonly string[];
	/** What each running base artifact read: each file's bytes' hash, by real path (the server's own first). */
	readonly #records: BaseInputs[] = [];
	/** Every file a record names. */
	readonly #recorded = new Set<string>();
	/** The base files that differ now (changed, gone, or new in a base directory): `base` while there is one. */
	readonly #differing = new Set<string>();
	/** Each path's comparison under way: the next one runs after it (the latest read decides). */
	readonly #comparing = new Map<string, Promise<void>>();
	/** Where base code lives: the base directories and the directories of recorded files outside them. */
	readonly #locations = new Set<string>();
	/** The locations and every ancestor of theirs: an entry there created, removed, moved or replaced concerns base code. */
	readonly #anchored = new Set<string>();
	/**
	 * The directories watched alone for base code: the recorded files' directories outside the base directories, and
	 * every existing ancestor of a location (its replacement or move is an event of its parent's watch).
	 */
	readonly #baseWatchers = new Map<string, FSWatcher>();
	/**
	 * The identity (inode and birth time) of each directory watched, by path: an event naming one whose identity is the
	 * same changed its attributes (`fs.watch` reports those as `rename` too), not the directory.
	 */
	readonly #identities = new Map<string, string | undefined>();
	/** Entries on the way to base code replaced since the last renewal: one renewal per burst of events. */
	readonly #renamed = new Set<string>();
	#renewing = false;
	#closed = false;
	/** The trees it watches: the roots, the base code, and plugin directories linked from outside the roots. */
	readonly #trees = new Set<string>();
	/** Its watches, one per directory of its trees. */
	readonly #watchers = new Map<string, FSWatcher>();
	/** A failure to watch was reported (once). */
	#reported = false;
	/** The generation the next change gets: every mark records a newer one than any before it. */
	#generation = 1;
	/** Each dirty plugin's latest change, by generation. */
	readonly #dirty = new Map<string, number>();
	readonly #install = new Set<string>();
	/** The latest change of the plugin set since the last discovery (0: none). */
	#set = 0;
	/** The latest change of a known plugin's `package.json` since the last discovery (0: none). */
	#manifest = 0;
	#discovery: Discovery = { plugins: [], problems: [] };
	/** The files each built facet read (its inputs and copies), by plugin and kind. */
	readonly #used = new Map<string, { readonly plugin: string; readonly files: ReadonlySet<string> }>();
	#value: JsonValue | undefined;
	#scheduled = false;

	constructor(options: WatcherOptions, batch: Batch) {
		super(batch);
		this.#options = options;
		// Events name paths under the directories as watched: by their real paths, as discovery names plugins.
		this.#roots = options.roots.map(real);
		const base = options.base.map(real);
		this.#baseDirs = base.filter(isDirectory);
		for (const dir of [...this.#roots, ...this.#baseDirs]) this.#watchTree(dir);
		this.#recordOwn(base);
	}

	get value(): JsonValue {
		this.#value ??= {
			dirty: [...this.#dirty.keys()].sort(),
			install: [...this.#install].sort(),
			set: this.#set > 0,
			base: this.#differing.size > 0,
		};
		return this.#value;
	}

	deliver(context: Context): void {
		const value = this.value;
		this.publish(value, [["r", value]], false, context);
	}

	/** Whether the next build discovers again: the plugin set or a plugin's `package.json` changed. */
	get needsDiscovery(): boolean {
		return this.#set > 0 || this.#manifest > 0;
	}

	/** What a discovery that starts now has seen. */
	discoverySnapshot(): DiscoverySnapshot {
		return { set: this.#set, manifest: this.#manifest };
	}

	/** The plugins discovery found: marks are for them (a removed one's install clears); the changes it had seen clear. */
	know(discovery: Discovery, seen: DiscoverySnapshot): void {
		// A plugin whose files moved (a single file became a directory, a facet file came or went) is dirty.
		const generation = this.#generation++;
		for (const plugin of discovery.plugins) {
			const before = this.#discovery.plugins.find(({ name }) => name === plugin.name);
			if (before !== undefined && !sameFiles(before, plugin)) this.#dirty.set(plugin.name, generation);
		}
		// A plugin no longer discovered: what its builds read no longer dirties anything.
		for (const [key, { plugin }] of this.#used) {
			if (!discovery.plugins.some(({ name }) => name === plugin)) this.#used.delete(key);
		}
		this.#discovery = discovery;
		if (this.#set === seen.set) this.#set = 0;
		if (this.#manifest === seen.manifest) this.#manifest = 0;
		// A removed plugin has nothing to install (its directory went, its package.json with it).
		for (const name of this.#install)
			if (!discovery.plugins.some((plugin) => plugin.name === name)) this.#install.delete(name);
		// A plugin directory linked from outside the roots: a tree of its own (a symlink is not followed).
		const linked = discovery.plugins.filter(
			({ dir, layout }) => layout === "directory" && !this.#roots.some((root) => inside(root, dir)),
		);
		for (const { dir } of linked) this.#watchTree(dir);
		for (const tree of this.#trees) {
			const kept =
				this.#roots.includes(tree) || this.#baseDirs.includes(tree) || linked.some((each) => each.dir === tree);
			if (!kept) this.#unwatchTree(tree);
		}
		this.#changed();
	}

	/** What `built` facets read: a later change of one of these files dirties their plugins. */
	used(built: readonly BuiltFacet[]): void {
		for (const facet of built) {
			if (facet.kind !== "script") continue;
			const files = new Set([...facet.inputs.map(({ file }) => file), ...facet.copied]);
			this.#used.set(`${facet.plugin}\u0000${facet.facet}`, { plugin: facet.plugin, files });
		}
	}

	/** The marks a build of `names` starts from: each one's latest change. */
	snapshot(names: Iterable<string>): MarkSnapshot {
		const plugins = new Map<string, number>();
		for (const name of names) plugins.set(name, this.#dirty.get(name) ?? 0);
		return { plugins };
	}

	/** `names` were applied everywhere: their marks clear unless a change came after `snapshot`. */
	applied(names: Iterable<string>, snapshot: MarkSnapshot): void {
		for (const name of names) {
			const latest = this.#dirty.get(name);
			if (latest !== undefined && latest <= (snapshot.plugins.get(name) ?? 0)) this.#dirty.delete(name);
		}
		this.#changed();
	}

	/** Plugin `name`'s dependencies were installed: its install mark clears and it is dirty (its packages changed). */
	installed(name: string): void {
		this.#install.delete(name);
		this.#dirty.set(name, this.#generation++);
		this.#changed();
	}

	/** Plugins were installed into a root: discovery runs at the next build (without waiting for the watch's events). */
	added(): void {
		this.#set = this.#generation++;
		this.#changed();
	}

	/**
	 * Adds the record of a running base artifact (a base bundle's `inputs`): `base` is set while one of its files differs
	 * from it. Each file's directory is watched alone (not its tree), then every file is compared once (an edit since the
	 * build has no later event); files under ignored directories are skipped.
	 */
	recordBase(inputs: BaseInputs): void {
		const record = new Map<string, string>();
		for (const [file, hash] of inputs) {
			const path = real(file);
			if (!ignored(path)) record.set(path, hash);
		}
		for (const path of record.keys()) this.#locate(dirname(path));
		this.#records.push(record);
		for (const path of record.keys()) {
			this.#recorded.add(path);
			this.#compare(path);
		}
	}

	/** Marks what a change of the file or directory at `path` (absolute) asks for. */
	mark(path: string): void {
		if (ignored(path)) return;
		if (this.#isBase(path)) {
			this.#compareAt(path);
			return;
		}
		this.#markPlugin(path, this.#generation++);
		this.#changed();
	}

	/** Stops watching. */
	close(): void {
		this.#closed = true;
		for (const watcher of [...this.#watchers.values(), ...this.#baseWatchers.values()]) watcher.close();
		this.#watchers.clear();
		this.#baseWatchers.clear();
		this.#identities.clear();
		this.#trees.clear();
	}

	/**
	 * Records the server's own base code `base` (files and the source files of directories), after their watches: the
	 * bytes Node loaded, as far as a read now can tell (an edit between Node's load and this read is not seen).
	 */
	#recordOwn(base: readonly string[]): void {
		const files = base.flatMap((path) => (this.#baseDirs.includes(path) ? sourceFiles(path) : [path]));
		for (const dir of this.#baseDirs) this.#locate(dir);
		for (const file of files) this.#locate(dirname(file));
		const record = new Map<string, string>();
		for (const file of files) {
			const hash = hashNow(file);
			if (hash !== undefined) record.set(file, hash);
		}
		this.#records.push(record);
		for (const path of record.keys()) this.#recorded.add(path);
	}

	/** Whether a change at `path` concerns base code: a recorded or differing file, or anything in a base directory. */
	#isBase(path: string): boolean {
		if (this.#recorded.has(path) || this.#differing.has(path) || this.#inBaseDir(path)) return true;
		for (const file of this.#recorded) if (inside(path, file)) return true;
		return false;
	}

	/** Whether `path` is a base directory or in one. */
	#inBaseDir(path: string): boolean {
		return this.#baseDirs.some((dir) => dir === path || inside(dir, path));
	}

	/**
	 * Compares the base files at or under `path` again: the recorded and differing ones, and the source files now in the
	 * base directories there (a directory added, removed or moved names only itself).
	 */
	#compareAt(path: string): void {
		const paths = new Set<string>();
		if (this.#recorded.has(path) || this.#differing.has(path)) paths.add(path);
		else {
			for (const file of [...this.#recorded, ...this.#differing]) if (inside(path, file)) paths.add(file);
			for (const dir of this.#baseDirs) {
				const scanned = dir === path || inside(path, dir) ? dir : inside(dir, path) ? path : undefined;
				if (scanned !== undefined) for (const file of sourceFiles(scanned)) paths.add(file);
			}
		}
		for (const file of paths) this.#compare(file);
	}

	/** Compares the base file at `path` once its comparisons under way are done: reads of one path run in order. */
	#compare(path: string): void {
		const next = (this.#comparing.get(path) ?? Promise.resolve()).then(() => this.#compareNow(path));
		this.#comparing.set(path, next);
		void next.then(() => {
			if (this.#comparing.get(path) === next) this.#comparing.delete(path);
		});
	}

	/**
	 * Reads the file at `path`: it differs while any record has other bytes for it (or it is gone), or, recorded by none,
	 * while it is a source file in a base directory.
	 */
	async #compareNow(path: string): Promise<void> {
		const hash = await hashOf(path);
		const recorded = this.#records.flatMap((record) => record.get(path) ?? []);
		const differs =
			recorded.length > 0
				? recorded.some((each) => each !== hash)
				: hash !== undefined && this.#inBaseDir(path) && SOURCE_EXTENSIONS.has(extname(path));
		if (differs === this.#differing.has(path)) return;
		if (differs) this.#differing.add(path);
		else this.#differing.delete(path);
		this.#changed();
	}

	/**
	 * A change under a root, at `generation`: in a plugin's directory, it dirties that plugin (and asks for an install
	 * and a new reading of its metadata for its `package.json`, for discovery for a facet file at its top); a single-file
	 * plugin's file dirties it (and asks for discovery when it is gone); elsewhere under a root (a directory or a
	 * single-file plugin's file added or removed, a directory that is no plugin yet), discovery; every plugin whose
	 * facets read the file is dirty too.
	 */
	#markPlugin(path: string, generation: number): void {
		const plugin = this.#discovery.plugins.find((each) => owns(each, path));
		if (plugin === undefined) {
			if (this.#roots.some((root) => inside(root, path))) this.#set = generation;
		} else if (plugin.layout === "file") {
			if (!existsSync(path)) this.#set = generation;
			this.#dirty.set(plugin.name, generation);
		} else if (path === join(plugin.dir, "package.json")) {
			this.#install.add(plugin.name);
			this.#manifest = generation;
		} else {
			if (path === plugin.dir || (dirname(path) === plugin.dir && this.#isFacetFile(basename(path)))) {
				this.#set = generation;
			}
			this.#dirty.set(plugin.name, generation);
		}
		for (const { plugin: user, files } of this.#used.values()) if (files.has(path)) this.#dirty.set(user, generation);
	}

	/** Whether `file` (at a plugin's top) is named as a facet file of one of the app's kinds. */
	#isFacetFile(file: string): boolean {
		return this.#options.kinds.some((kind) => FACET_EXTENSIONS.some((extension) => file === `${kind}${extension}`));
	}

	/**
	 * Adds `dir` to where base code lives (a base directory, or one holding recorded files outside them): it and its
	 * ancestors are watched. A directory inside a base directory is its tree's.
	 */
	#locate(dir: string): void {
		if (this.#locations.has(dir) || (this.#inBaseDir(dir) && !this.#baseDirs.includes(dir))) return;
		this.#locations.add(dir);
		for (let each = dir; ; each = dirname(each)) {
			this.#anchored.add(each);
			if (each === dirname(each)) break;
		}
		this.#watchLocation(dir);
	}

	/**
	 * Watches location `dir`'s existing ancestors alone, then `dir` itself: as a tree for a base directory, alone for
	 * one holding recorded files. A part that does not exist is skipped: its parent's watch reports its arrival.
	 */
	#watchLocation(dir: string): void {
		const ancestors: string[] = [];
		for (let each = dirname(dir); ; each = dirname(each)) {
			ancestors.unshift(each);
			if (each === dirname(each)) break;
		}
		for (const ancestor of ancestors) this.#watchAlone(ancestor);
		if (this.#baseDirs.includes(dir)) this.#watchDirs(dir);
		else this.#watchAlone(dir);
	}

	/**
	 * Watches directory `dir` alone (once) for base code: a recorded (or differing) file there is compared; an entry on the
	 * way to a location created, removed, moved or replaced (another identity: not an attribute change) renews the
	 * watches under it. A directory that does not exist or cannot be watched (an ancestor without access) is skipped.
	 */
	#watchAlone(dir: string): void {
		if (this.#baseWatchers.has(dir) || this.#reported) return;
		let watcher: FSWatcher;
		try {
			watcher = watch(dir, (event, file) => {
				if (file === null) return;
				const path = join(dir, file);
				if (this.#recorded.has(path) || this.#differing.has(path)) this.mark(path);
				else if (event === "rename" && this.#anchored.has(path) && this.#replaced(path))
					this.#renamedOnTheWay(path);
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") this.#failed(error);
			return;
		}
		watcher.on("error", (error) => this.#failed(error));
		this.#baseWatchers.set(dir, watcher);
		this.#identities.set(dir, identityOf(dir));
	}

	/** Whether the directory at `path` is not the one watched there (created, removed, or another one now). */
	#replaced(path: string): boolean {
		return identityOf(path) !== this.#identities.get(path);
	}

	/**
	 * Renews the watches under `path`, renamed on the way to base code, once the events of this task are in: a burst
	 * renews each subtree once (the outermost renamed path covers those under it).
	 */
	#renamedOnTheWay(path: string): void {
		this.#renamed.add(path);
		if (this.#renewing) return;
		this.#renewing = true;
		setImmediate(() => {
			this.#renewing = false;
			const renamed = [...this.#renamed];
			this.#renamed.clear();
			if (this.#closed || this.#reported) return;
			for (const each of renamed) if (!renamed.some((other) => inside(other, each))) this.#reconcile(each);
		});
	}

	/**
	 * The directory at `path`, on the way to base code, was created, removed, moved or replaced (its watches may be dead,
	 * its inode reused: renewed whatever they are): every base watch at or under it starts again where the paths now are,
	 * and the base files there are compared.
	 */
	#reconcile(path: string): void {
		for (const [dir, watcher] of this.#baseWatchers) {
			if (dir !== path && !inside(path, dir)) continue;
			watcher.close();
			this.#baseWatchers.delete(dir);
			this.#identities.delete(dir);
		}
		for (const dir of this.#baseDirs) if (dir === path || inside(path, dir)) this.#unwatchDirs(dir);
		for (const dir of this.#locations) if (dir === path || inside(path, dir)) this.#watchLocation(dir);
		this.#compareAt(path);
	}

	/** Watches the tree at `dir` (once): it and every directory under it but ignored ones; a missing one is skipped. */
	#watchTree(dir: string): void {
		if (this.#trees.has(dir)) return;
		this.#trees.add(dir);
		this.#watchDirs(dir);
	}

	/** Stops watching the tree at `dir`. */
	#unwatchTree(dir: string): void {
		this.#trees.delete(dir);
		this.#unwatchDirs(dir);
	}

	/** Watches `dir` and, walking down, every directory under it but ignored ones (each not watched yet). */
	#watchDirs(dir: string): void {
		if (this.#watchers.has(dir) || this.#reported) return;
		let watcher: FSWatcher;
		try {
			watcher = watch(dir, (_event, file) => {
				if (file !== null) this.#changedIn(join(dir, file));
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#failed(error);
			return;
		}
		watcher.on("error", (error) => this.#failed(error));
		this.#watchers.set(dir, watcher);
		this.#identities.set(dir, identityOf(dir));
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			// Removed meanwhile: its parent's event says so.
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !IGNORED.has(entry.name)) this.#watchDirs(join(dir, entry.name));
		}
	}

	/**
	 * An event for `path` in a watched directory: a directory gets its watches (renewed when it is another directory than
	 * the one watched: removed and made again, its old watches dead, its inode possibly reused), a removed one loses
	 * them; marked.
	 */
	#changedIn(path: string): void {
		const name = basename(path);
		if (!IGNORED.has(name)) {
			if (isDirectory(path)) {
				if (this.#watchers.has(path) && this.#replaced(path)) this.#unwatchDirs(path);
				this.#watchDirs(path);
			} else if (this.#watchers.has(path)) this.#unwatchDirs(path);
		}
		this.mark(path);
	}

	/** Stops watching `dir` and the directories under it (it was removed, or its tree is not watched any more). */
	#unwatchDirs(dir: string): void {
		for (const [watched, watcher] of this.#watchers) {
			if (watched !== dir && !inside(dir, watched)) continue;
			watcher.close();
			this.#watchers.delete(watched);
			this.#identities.delete(watched);
		}
	}

	/** Watching failed: reported once; every watch stops (the app builds on demand). */
	#failed(error: unknown): void {
		this.close();
		if (this.#reported) return;
		this.#reported = true;
		this.#options.failed(error);
	}

	/** The marks changed: one publication per microtask turn while someone watches or derives from them. */
	#changed(): void {
		this.#value = undefined;
		if (this.#scheduled || (!this.watched && this.dependents.size === 0)) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.batch.within(() => this.changed(), BACKGROUND_CONTEXT);
		});
	}
}

/** Whether `path` is `plugin`'s: in its directory, or one of a single-file plugin's files. */
function owns(plugin: Plugin, path: string): boolean {
	if (plugin.layout === "file") return Object.values(plugin.facets).includes(path);
	return plugin.dir === path || inside(plugin.dir, path);
}

/**
 * Whether `path` is a directory, never following a link (as the scan of a tree does not); one that cannot be read (gone,
 * a link loop, no access) is none: a watch callback must not throw.
 */
function isDirectory(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
	} catch {
		return false;
	}
}

/** Whether `path` lies under a directory never watched (`node_modules`, `.git`). */
function ignored(path: string): boolean {
	return path.split(sep).some((part) => IGNORED.has(part));
}

/** The source files at `path`: itself when it is one, every one under it (ignored directories skipped) when a directory. */
function sourceFiles(path: string): string[] {
	if (!isDirectory(path)) return SOURCE_EXTENSIONS.has(extname(path)) ? [path] : [];
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => (IGNORED.has(entry.name) ? [] : sourceFiles(join(path, entry.name))));
}

/** The hash of the bytes of the file at `path` now (synchronously), `undefined` when it cannot be read. */
function hashNow(path: string): string | undefined {
	try {
		return contentHash(readFileSync(path));
	} catch {
		return undefined;
	}
}

/** The hash of the bytes of the file at `path`, `undefined` when it cannot be read (gone, a directory, no access). */
async function hashOf(path: string): Promise<string | undefined> {
	try {
		return contentHash(await readFile(path));
	} catch {
		return undefined;
	}
}

/**
 * The identity of the directory at `path`: its inode and birth time (an inode is reused at once by a directory made
 * again; its birth time is new), not following a link; `undefined` when there is none.
 */
function identityOf(path: string): string | undefined {
	try {
		const stats = lstatSync(path, { bigint: true });
		return `${stats.ino}:${stats.birthtimeNs}`;
	} catch {
		return undefined;
	}
}

/** `dir` absolute and by its real path; as given (absolute) when it does not exist. */
function real(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return resolve(dir);
	}
}
