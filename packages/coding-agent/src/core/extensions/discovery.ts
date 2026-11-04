import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
	PackageResolutionError,
	readPackageJson,
	resolveManifestPath,
	toPackageResolutionError,
} from "../pi-manifest.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** Manifests on the current resolution path, and the broken packages skipped so far. */
interface DiscoveryContext {
	manifestRoots: Set<string>;
	errors: PackageResolutionError[];
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

// Returns [] for a broken or unreadable package so callers skip it instead of scanning its files.
function resolveExtensionPackageInternal(dir: string, context: DiscoveryContext): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	try {
		const packageJson = readPackageJson(packageJsonPath);
		const extensions = packageJson ? getPiManifest(packageJson)?.extensions : undefined;
		if (packageJson && extensions !== undefined) {
			const manifestRoot = realpathSync(dir);
			if (context.manifestRoots.has(manifestRoot)) {
				throw new PackageResolutionError(
					packageJsonPath,
					"pi.extensions references form a cycle back to this package",
				);
			}
			context.manifestRoots.add(manifestRoot);
			try {
				return resolveExtensionManifestEntriesInternal(dir, extensions, packageJson, context);
			} finally {
				context.manifestRoots.delete(manifestRoot);
			}
		}

		const moduleEntry = resolveDirectoryModuleEntry(dir, packageJson);
		return moduleEntry ? [moduleEntry] : null;
	} catch (error) {
		context.errors.push(toPackageResolutionError(error, dir));
		return [];
	}
}

function discoverExtensionsInDirInternal(dir: string, context: DiscoveryContext): string[] {
	if (!existsSync(dir)) return [];
	return resolveExtensionPackageInternal(dir, context) ?? discoverExtensionDirectoryContentsInternal(dir, context);
}

function discoverExtensionDirectoryContentsInternal(dir: string, context: DiscoveryContext): string[] {
	if (!existsSync(dir)) return [];
	let matcher: ReturnType<typeof ignore>;
	let entries: Dirent[];
	try {
		matcher = createIgnoreMatcher(dir);
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		context.errors.push(toPackageResolutionError(error, dir));
		return [];
	}
	const extensions: string[] = [];

	for (const entry of entries) {
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
				// A dangling symlink is not an extension; any other failure is reported.
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
					context.errors.push(toPackageResolutionError(error, entryPath));
				}
				continue;
			}
		}
		if (matcher.ignores(isDirectory ? `${entry.name}/` : entry.name)) continue;

		if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			extensions.push(entryPath);
		} else if (isDirectory) {
			const packageEntries = resolveExtensionPackageInternal(entryPath, context);
			if (packageEntries) extensions.push(...packageEntries);
		}
	}
	return extensions;
}

function resolveExtensionManifestEntriesInternal(
	root: string,
	entries: string[],
	packageJson: PackageJson,
	context: DiscoveryContext,
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
				if (entryPath !== resolvedRoot) return discoverExtensionsInDirInternal(entryPath, context);
				const moduleEntry = resolveDirectoryModuleEntry(entryPath, packageJson);
				return moduleEntry ? [moduleEntry] : discoverExtensionDirectoryContentsInternal(entryPath, context);
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

/**
 * Discover a directory as one extension package, falling back to its extension contents.
 * Broken packages are skipped and their errors appended to `errors`.
 */
export function discoverExtensionsInDir(dir: string, errors: PackageResolutionError[]): string[] {
	return discoverExtensionsInDirInternal(dir, { manifestRoots: new Set(), errors });
}

/**
 * Discover direct extension files and immediate extension package directories.
 * Broken packages are skipped and their errors appended to `errors`.
 */
export function discoverExtensionDirectoryContents(dir: string, errors: PackageResolutionError[]): string[] {
	return discoverExtensionDirectoryContentsInternal(dir, { manifestRoots: new Set(), errors });
}
