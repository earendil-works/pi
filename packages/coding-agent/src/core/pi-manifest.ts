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
		throw error;
	}

	const packageJson: unknown = JSON.parse(stripBom(contents));
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
