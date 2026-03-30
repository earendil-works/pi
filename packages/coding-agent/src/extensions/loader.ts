import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createJiti } from "jiti";
import type { BuiltInExtensionRegistration } from "./built-ins.js";
import type { ExtensionManager } from "./manager.js";
import type { ExtensionFactory } from "./types.js";

export interface ExtensionLoaderOptions {
	/** Project root (used for ./.mu/extensions) */
	projectDir?: string;
	/** Config dir root (used for ~/.mu/agent/extensions or $MU_CODING_AGENT_DIR/extensions) */
	configDir?: string;
	/** Additional discovery directories */
	extraDirs?: string[];
	/** Built-in extensions loaded in-process after discovered files */
	builtInExtensions?: BuiltInExtensionRegistration[];
	log?: (message: string, err?: unknown) => void;
}

export interface ExtensionLoadResult {
	path: string;
	sourceId: string;
	ok: boolean;
	error?: string;
}

const EXTENSIONS_DIRNAME = "extensions";

function buildHostAliases(log: (message: string, err?: unknown) => void): Record<string, string> {
	// Extensions may live outside the host's node_modules tree (e.g. ~/.mu/agent/extensions), which means
	// normal Node resolution won't find the host's dependencies.
	//
	// We use jiti's `alias` option to force core imports to resolve to the host installation.
	const require = createRequire(import.meta.url);
	const aliases: Record<string, string> = {};

	const specs = [
		"@sinclair/typebox",
		"@kennyfrc/mu-ai",
		"@kennyfrc/mu-agent-core",
		"@kennyfrc/mu-tui",
		"@kennyfrc/mu-coding-agent",
	];

	for (const spec of specs) {
		try {
			aliases[spec] = require.resolve(spec);
		} catch (err) {
			log(`Failed to resolve host dependency for extension alias: ${spec}`, err);
		}
	}

	return aliases;
}

function getDefaultConfigDir(): string {
	return resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu", "agent"));
}

function isExtensionFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (ext === ".d.ts" || ext === ".d.mts" || ext === ".d.cts") return false;
	return ext === ".ts" || ext === ".mts" || ext === ".cts" || ext === ".js" || ext === ".mjs" || ext === ".cjs";
}

async function collectFilesRecursive(dir: string): Promise<string[]> {
	const results: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await collectFilesRecursive(fullPath)));
		} else if (entry.isFile() && isExtensionFile(fullPath)) {
			results.push(fullPath);
		}
	}

	return results;
}

export class ExtensionLoader {
	private manager: ExtensionManager;
	private projectDir: string;
	private configDir: string;
	private extraDirs: string[];
	private builtInExtensions: BuiltInExtensionRegistration[];
	private log: (message: string, err?: unknown) => void;
	private jiti: ReturnType<typeof createJiti>;

	constructor(manager: ExtensionManager, opts: ExtensionLoaderOptions = {}) {
		this.manager = manager;
		this.projectDir = resolve(opts.projectDir ?? process.cwd());
		this.configDir = resolve(opts.configDir ?? getDefaultConfigDir());
		this.extraDirs = (opts.extraDirs ?? []).map((d) => resolve(d));
		this.builtInExtensions = opts.builtInExtensions ?? [];
		this.log = opts.log ?? (() => {});

		this.jiti = createJiti(import.meta.url, {
			moduleCache: false,
			alias: buildHostAliases(this.log),
		});
	}

	getDiscoveryDirs(): string[] {
		const dirs = [
			join(this.configDir, EXTENSIONS_DIRNAME),
			join(this.projectDir, ".mu", EXTENSIONS_DIRNAME),
			...this.extraDirs,
		];
		return dirs;
	}

	async discoverExtensionFiles(): Promise<string[]> {
		const dirs = this.getDiscoveryDirs();
		const files: string[] = [];

		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			try {
				files.push(...(await collectFilesRecursive(dir)));
			} catch (err) {
				this.log(`Failed to scan extensions dir: ${dir}`, err);
			}
		}

		// Stable order with duplicate preference by basename:
		// If both .ts and .js variants exist for the same relative path, keep TypeScript source only.
		files.sort();

		const extPriority = (path: string): number => {
			const ext = extname(path).toLowerCase();
			if (ext === ".ts" || ext === ".mts" || ext === ".cts") return 0;
			if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return 1;
			return 2;
		};

		const stem = (path: string): string => {
			const ext = extname(path);
			return ext ? path.slice(0, -ext.length) : path;
		};

		const bestByStem = new Map<string, string>();
		for (const file of files) {
			const key = stem(file);
			const prev = bestByStem.get(key);
			if (!prev || extPriority(file) < extPriority(prev)) {
				bestByStem.set(key, file);
			}
		}

		return Array.from(bestByStem.values()).sort();
	}

	async loadAll(): Promise<ExtensionLoadResult[]> {
		const files = await this.discoverExtensionFiles();
		const results: ExtensionLoadResult[] = [];

		for (const filePath of files) {
			const absPath = resolve(filePath);
			const sourceId = absPath;

			try {
				const factory = (await this.jiti.import(absPath, { default: true })) as unknown;
				if (typeof factory !== "function") {
					results.push({ path: absPath, sourceId, ok: false, error: "Default export is not a function" });
					continue;
				}
				await this.manager.loadExtension(factory as ExtensionFactory, sourceId);
				results.push({ path: absPath, sourceId, ok: true });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({ path: absPath, sourceId, ok: false, error: msg });
				this.log(`Failed to load extension: ${absPath}`, err);
			}
		}

		for (const builtIn of this.builtInExtensions) {
			try {
				await this.manager.loadExtension(builtIn.factory, builtIn.sourceId);
				results.push({ path: builtIn.sourceId, sourceId: builtIn.sourceId, ok: true });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				results.push({ path: builtIn.sourceId, sourceId: builtIn.sourceId, ok: false, error: msg });
				this.log(`Failed to load built-in extension: ${builtIn.sourceId}`, err);
			}
		}

		return results;
	}

	async reloadAll(): Promise<ExtensionLoadResult[]> {
		this.manager.unloadAllExtensions();
		return this.loadAll();
	}
}
