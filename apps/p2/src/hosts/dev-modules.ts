// Dev restart baselines belong to live processes, not to source directories or filesystem events.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type ModuleSource, registerHooks } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DevModule, parseDevModules, parseDevPluginFiles } from "../runtime/dev-protocol.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const pluginsDirectory = fileURLToPath(new URL("../../plugins/", import.meta.url));
const packages = fileURLToPath(new URL("../../../../packages/", import.meta.url));
const roots = new Set([project, packages]);
try {
	roots.add(`${realpathSync(packages)}${sep}`);
} catch {
	// Small test projects need not have workspace packages.
}
const loaded = new Map<string, string>();
export const loadedModuleHashes: ReadonlyMap<string, string> = loaded;
/** Plugin files the facet loader loaded (any reload copy): their saves mark the plugin dirty, not a restart. */
const pluginFiles = new Set<string>();
export const loadedPluginFiles: ReadonlySet<string> = pluginFiles;
let publication: ReturnType<typeof setImmediate> | undefined;
/** Whether this worker wrote its report file (removed when it exits). */
let reporting = false;

/** This process's report: the modules it loaded with their hashes, and the plugin files its facet loader loaded. */
const report = () => ({
	type: "dev-modules",
	modules: [...loaded].map(([file, hash]) => ({ file, hash })),
	pluginFiles: [...pluginFiles],
});

/**
 * Publishes the report: a dev server to its supervisor over IPC; a session worker (whose IPC channel is Chord's link)
 * as `<P2_DEV_MODULE_DIR>/<server pid>-<pid>.json` (the server forked it: `ppid`), which the dev server reads
 * (`LoadedModules`), and removes when it exits.
 */
function publish(): void {
	const directory = process.env.P2_DEV_MODULE_DIR;
	if (publication) return;
	if (directory) {
		const file = join(directory, `${process.ppid}-${process.pid}.json`);
		if (!reporting) {
			reporting = true;
			process.once("exit", () => rmSync(file, { force: true }));
		}
		publication = setImmediate(() => {
			publication = undefined;
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(file, JSON.stringify(report()), { mode: 0o600 });
		});
		return;
	}
	if (process.env.P2_DEV_MODULE_REPORT !== "1" || !process.connected) return;
	publication = setImmediate(() => {
		publication = undefined;
		if (process.connected) process.send?.(report(), () => {});
	});
}

export function contentHash(source: ModuleSource): string {
	const bytes =
		typeof source === "string"
			? source
			: ArrayBuffer.isView(source)
				? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
				: new Uint8Array(source);
	return createHash("sha256").update(bytes).digest("hex");
}

/** The first loaded copy is the runtime baseline; facet copies carrying reload queries are replaceable. */
function record(url: string, source?: ModuleSource): void {
	if (!url.startsWith("file:")) return;
	const location = new URL(url);
	if (location.searchParams.has("chord2-reload")) {
		location.search = "";
		const file = fileURLToPath(location);
		if (!file.startsWith(pluginsDirectory) || pluginFiles.has(file)) return;
		pluginFiles.add(file);
		publish();
		return;
	}
	const file = fileURLToPath(location);
	if (![...roots].some((root) => file.startsWith(root)) || loaded.has(file)) return;
	loaded.set(file, contentHash(source ?? readFileSync(file)));
	publish();
}

// Collect before startServer({ dev: true }) can be called, even without P2_DEV in the environment.
// Only dev servers consume these hashes; only explicitly opted-in workers publish them over private IPC.
registerHooks({
	load(url, context, nextLoad) {
		const result = nextLoad(url, context);
		record(url, result.source);
		return result;
	},
});
// The preload graph itself is loaded before a hook can run. Capture its startup sources as well.
for (const url of [
	import.meta.url,
	new URL("../source.ts", import.meta.url).href,
	new URL("../source-resolver.ts", import.meta.url).href,
	new URL("../runtime/dev-protocol.ts", import.meta.url).href,
])
	record(url);

/** Server and worker snapshots stay separate: a fresh worker cannot hide an older worker's loaded code. */
export class LoadedModules {
	readonly #processes = new Map<string, ReadonlyMap<string, string>>();
	readonly #pluginFiles = new Map<string, ReadonlySet<string>>();
	/** Where session workers write their reports (`P2_DEV_MODULE_DIR`), read at each use. */
	readonly #reports: string | undefined;

	constructor(server?: ReadonlyMap<string, string>, serverPluginFiles?: ReadonlySet<string>, reports?: string) {
		if (server) this.#processes.set("server", server);
		if (serverPluginFiles) this.#pluginFiles.set("server", serverPluginFiles);
		this.#reports = reports;
	}

	/**
	 * Reads the workers' reports: a live worker's baseline is set; an exited one's report and baseline go, and so do
	 * reports of another server run's workers (named with another server pid, or in the layout before it): a pid of an
	 * ended run may be alive again as an unrelated process, whose "report" would keep a restart notice up.
	 */
	#readReports(): void {
		const directory = this.#reports;
		if (directory === undefined) return;
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			return;
		}
		const live = new Set<string>();
		for (const name of names) {
			const own = /^(\d+)-(\d+)\.json$/.exec(name);
			const pid = Number(own?.[2]);
			if (Number(own?.[1]) !== process.pid) {
				rmSync(join(directory, name), { force: true });
				continue;
			}
			const key = `worker:${pid}`;
			try {
				process.kill(pid, 0);
			} catch {
				rmSync(join(directory, name), { force: true });
				continue;
			}
			live.add(key);
			try {
				this.receive(key, JSON.parse(readFileSync(join(directory, name), "utf8")));
			} catch {
				// A report being written: the next read gets it.
			}
		}
		for (const key of this.#processes.keys()) if (key.startsWith("worker:") && !live.has(key)) this.delete(key);
	}

	set(process: string, modules: readonly DevModule[]): void {
		this.#processes.set(process, new Map(modules.map(({ file, hash }) => [resolve(file), hash])));
	}

	setPluginFiles(process: string, files: Iterable<string>): void {
		this.#pluginFiles.set(process, new Set([...files].map((file) => resolve(file))));
	}

	receive(process: string, message: unknown): void {
		const modules = parseDevModules(message);
		if (modules)
			this.set(
				process,
				modules.filter(({ file }) => [...roots].some((root) => resolve(file).startsWith(root))),
			);
		const files = parseDevPluginFiles(message);
		if (files) this.setPluginFiles(process, files);
	}

	delete(process: string): void {
		this.#processes.delete(process);
		this.#pluginFiles.delete(process);
	}

	/** Plugin files some live server/worker loaded through the facet loader. */
	pluginFiles(): Set<string> {
		this.#readReports();
		const files = new Set<string>();
		for (const loaded of this.#pluginFiles.values()) for (const file of loaded) files.add(file);
		return files;
	}

	changed(): string[] {
		this.#readReports();
		const current = new Map<string, string | undefined>();
		const changed = new Set<string>();
		for (const modules of this.#processes.values()) {
			for (const [file, hash] of modules) {
				if (!current.has(file)) {
					try {
						current.set(file, contentHash(readFileSync(file)));
					} catch {
						current.set(file, undefined);
					}
				}
				if (current.get(file) !== hash) changed.add(file);
			}
		}
		return [...changed].sort();
	}
}
