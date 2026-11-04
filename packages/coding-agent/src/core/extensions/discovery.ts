import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import {
	expandManifestGlob,
	getPiManifest,
	hasManifestGlobMagic,
	type ManifestPattern,
	normalizeManifestPattern,
	type PackageJson,
	readPackageJson,
	resolveManifestPath,
} from "../pi-manifest.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export class ExtensionManifestResolutionError extends Error {
	readonly code = "EXTENSION_MANIFEST_CYCLE";
	readonly manifestRoot: string;

	constructor(manifestRoot: string) {
		super(`Cyclic extension manifest reference: ${manifestRoot}`);
		this.name = "ExtensionManifestResolutionError";
		this.manifestRoot = manifestRoot;
	}
}

function getMatchCandidates(entryPath: string, root: string) {
	return {
		relative: relative(root, entryPath).split(sep).join("/"),
		name: basename(entryPath),
		absolute: entryPath.split(sep).join("/"),
	};
}

function matchesPattern(entryPath: string, pattern: ManifestPattern, root: string): boolean {
	const candidates = getMatchCandidates(entryPath, root);
	return (
		minimatch(candidates.relative, pattern.value) ||
		(!pattern.rootAnchored && minimatch(candidates.name, pattern.value)) ||
		minimatch(candidates.absolute, pattern.value)
	);
}

function matchesExactPath(entryPath: string, pattern: ManifestPattern, root: string): boolean {
	const candidates = getMatchCandidates(entryPath, root);
	return candidates.relative === pattern.value || candidates.absolute === pattern.value;
}

function createIgnoreMatcher(dir: string): ReturnType<typeof ignore> {
	const matcher = ignore();
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (existsSync(ignorePath)) matcher.add(readFileSync(ignorePath, "utf-8"));
	}
	return matcher;
}

function resolveModulePath(entryPath: string): string | null {
	for (const candidate of [
		entryPath,
		`${entryPath}.ts`,
		`${entryPath}.js`,
		join(entryPath, "index.ts"),
		join(entryPath, "index.js"),
	]) {
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
	}
	return null;
}

function resolveDirectoryModuleEntry(dir: string, packageJson: PackageJson | null): string | null {
	const main = packageJson?.main;
	if (typeof main === "string" && main.length > 0) {
		const mainEntry = resolveModulePath(resolve(dir, main));
		if (mainEntry) return mainEntry;
	}

	return resolveModulePath(join(dir, "index"));
}

function resolveExtensionPackageInternal(dir: string, manifestRoots: Set<string>): string[] | null {
	const packageJson = readPackageJson(join(dir, "package.json"));
	const extensions = packageJson ? getPiManifest(packageJson)?.extensions : undefined;
	if (packageJson && extensions !== undefined) {
		const manifestRoot = realpathSync(dir);
		if (manifestRoots.has(manifestRoot)) throw new ExtensionManifestResolutionError(manifestRoot);
		manifestRoots.add(manifestRoot);
		try {
			return resolveExtensionManifestEntriesInternal(dir, extensions, manifestRoots, packageJson);
		} finally {
			manifestRoots.delete(manifestRoot);
		}
	}

	const moduleEntry = resolveDirectoryModuleEntry(dir, packageJson);
	return moduleEntry ? [moduleEntry] : null;
}

function discoverExtensionsInDirInternal(dir: string, manifestRoots: Set<string>): string[] {
	if (!existsSync(dir)) return [];
	return (
		resolveExtensionPackageInternal(dir, manifestRoots) ??
		discoverExtensionDirectoryContentsInternal(dir, manifestRoots)
	);
}

function discoverExtensionDirectoryContentsInternal(dir: string, manifestRoots: Set<string>): string[] {
	if (!existsSync(dir)) return [];
	const matcher = createIgnoreMatcher(dir);
	const extensions: string[] = [];

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const entryPath = join(dir, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(entryPath);
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
		}
		if (matcher.ignores(isDirectory ? `${entry.name}/` : entry.name)) continue;

		if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			extensions.push(entryPath);
		} else if (isDirectory) {
			const packageEntries = resolveExtensionPackageInternal(entryPath, manifestRoots);
			if (packageEntries) extensions.push(...packageEntries);
		}
	}
	return extensions;
}

function resolveExtensionManifestEntriesInternal(
	root: string,
	entries: string[],
	manifestRoots: Set<string>,
	packageJson: PackageJson,
): string[] {
	const exclusions = entries
		.filter((entry) => entry.startsWith("!"))
		.map((entry) => normalizeManifestPattern(entry.slice(1)));
	const forceIncludes = entries
		.filter((entry) => entry.startsWith("+"))
		.map((entry) => normalizeManifestPattern(entry.slice(1)));
	const forceExcludes = entries
		.filter((entry) => entry.startsWith("-"))
		.map((entry) => normalizeManifestPattern(entry.slice(1)));
	const sourcePaths = entries
		.filter((entry) => !entry.startsWith("!") && !entry.startsWith("+") && !entry.startsWith("-"))
		.flatMap((entry) =>
			hasManifestGlobMagic(entry) ? expandManifestGlob(entry, root) : [resolveManifestPath(entry, root)],
		);
	const resolvedRoot = resolve(root);
	const discovered = Array.from(
		new Set(
			sourcePaths.flatMap((entryPath) => {
				if (!existsSync(entryPath)) return [];
				if (!statSync(entryPath).isDirectory()) return [entryPath];
				if (entryPath !== resolvedRoot) return discoverExtensionsInDirInternal(entryPath, manifestRoots);
				const moduleEntry = resolveDirectoryModuleEntry(entryPath, packageJson);
				return moduleEntry ? [moduleEntry] : discoverExtensionDirectoryContentsInternal(entryPath, manifestRoots);
			}),
		),
	);
	return discovered.filter(
		(entry) =>
			!forceExcludes.some((pattern) => matchesExactPath(entry, pattern, root)) &&
			(forceIncludes.some((pattern) => matchesExactPath(entry, pattern, root)) ||
				!exclusions.some((pattern) => matchesPattern(entry, pattern, root))),
	);
}

/** Discover a directory as one extension package, falling back to its extension contents. */
export function discoverExtensionsInDir(dir: string): string[] {
	return discoverExtensionsInDirInternal(dir, new Set());
}

/** Discover direct extension files and immediate extension package directories. */
export function discoverExtensionDirectoryContents(dir: string): string[] {
	return discoverExtensionDirectoryContentsInternal(dir, new Set());
}
