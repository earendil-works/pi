import { globSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { Minimatch } from "minimatch";
import { stripBom } from "../utils/text.ts";

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	changelogPath?: string;
}

export type PackageJson = Record<string, unknown>;

/**
 * A package, package.json, or extension directory that cannot be read or resolved.
 * Pi skips it and reports this error instead of failing to launch.
 */
export class PackageResolutionError extends Error {
	readonly path: string;

	constructor(path: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PackageResolutionError";
		this.path = path;
	}
}

/**
 * Report a file-system failure under `path` as a skipped resource. Pi reads files users and packages
 * control, so permission and similar errors are expected; any other error is a bug and is rethrown.
 */
export function toPackageResolutionError(error: unknown, path: string): PackageResolutionError {
	if (error instanceof PackageResolutionError) return error;
	if (error instanceof Error && "code" in error && typeof error.code === "string") {
		return new PackageResolutionError(path, `Cannot read: ${error.message}`, { cause: error });
	}
	throw error;
}

export interface ManifestPattern {
	value: string;
	rootAnchored: boolean;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;
const MANIFEST_GLOB_OPTIONS = { magicalBraces: true, windowsPathsNoEscape: true };

export function normalizeManifestPattern(pattern: string): ManifestPattern {
	const rootAnchored = pattern.startsWith("./") || pattern.startsWith(".\\");
	const value = rootAnchored ? pattern.slice(2) : pattern;
	return { value: value.replaceAll("\\", "/"), rootAnchored };
}

export function hasManifestGlobMagic(pattern: string): boolean {
	return new Minimatch(pattern, MANIFEST_GLOB_OPTIONS).hasMagic();
}

export function resolveManifestPath(pattern: string, root: string): string {
	return resolve(root, pattern.replaceAll("\\", "/"));
}

/** Glob entries discover visible paths; exact entries can target dot paths or symlinked trees. */
export function expandManifestGlob(pattern: string, root: string): string[] {
	return globSync(pattern.replaceAll("\\", "/"), { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort();
}

function isObject(value: unknown): value is PackageJson {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPackageJson(packageJsonPath: string): PackageJson | null {
	let contents: string;
	try {
		contents = readFileSync(packageJsonPath, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw toPackageResolutionError(error, packageJsonPath);
	}

	let packageJson: unknown;
	try {
		packageJson = JSON.parse(stripBom(contents));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new PackageResolutionError(packageJsonPath, `Invalid package.json: ${reason}`, { cause: error });
	}
	return isObject(packageJson) ? packageJson : null;
}

export function getPiManifest(packageJson: PackageJson): PiManifest | null {
	if (!isObject(packageJson.pi)) return null;

	const manifest: PiManifest = {};
	for (const field of RESOURCE_FIELDS) {
		const entries = packageJson.pi[field];
		if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
			manifest[field] = entries;
		}
	}

	const changelogPath = packageJson.pi.changelogPath;
	if (typeof changelogPath === "string") manifest.changelogPath = changelogPath;

	return manifest;
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	const packageJson = readPackageJson(packageJsonPath);
	return packageJson ? getPiManifest(packageJson) : null;
}
