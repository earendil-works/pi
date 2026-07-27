import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "./package-manager.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";

export const LOADOUT_CUSTOM_TYPE = "pi.loadout";
export const LOADOUT_ENTRY_VERSION = 1;

export type LoadoutResourceType = "extension" | "skill" | "prompt" | "theme";
export type LoadoutResourceScope = "user" | "project";

export interface PackageLoadoutResourceReference {
	type: LoadoutResourceType;
	origin: "package";
	/** Canonical package identity without an npm version or git ref. */
	source: string;
	/** POSIX-style path relative to the package root. */
	relativePath: string;
}

export interface TopLevelLoadoutResourceReference {
	type: LoadoutResourceType;
	origin: "top-level";
	scope: LoadoutResourceScope;
	/** Path relative to the standard user or project resource root. */
	relativePath?: string;
	/** Canonical local fallback for resources outside the standard roots. */
	path?: string;
}

export type LoadoutResourceReference = PackageLoadoutResourceReference | TopLevelLoadoutResourceReference;

export interface LoadoutOverride {
	reference: LoadoutResourceReference;
	enabled: boolean;
}

export interface LoadoutEntryPayload {
	version: 1;
	overrides: LoadoutOverride[];
}

export interface SelectableLoadoutResource {
	reference: LoadoutResourceReference;
	path: string;
	/** Enabled state after the session overlay. */
	enabled: boolean;
	/** Enabled state from package/settings resolution before the session overlay. */
	defaultEnabled: boolean;
	metadata: PathMetadata;
}

export interface LoadoutSnapshot {
	resources: SelectableLoadoutResource[];
	overrides: LoadoutOverride[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadoutResourceLoader {
	getLoadoutSnapshot(): LoadoutSnapshot;
	setLoadoutOverrides(overrides: readonly LoadoutOverride[]): void;
}

export interface ResolveLoadoutOverlayOptions {
	cwd: string;
	agentDir: string;
}

export interface ResolvedLoadoutOverlay {
	resolvedPaths: ResolvedPaths;
	snapshot: LoadoutSnapshot;
}

const RESOURCE_COLLECTIONS = [
	["extensions", "extension"],
	["skills", "skill"],
	["prompts", "prompt"],
	["themes", "theme"],
] as const satisfies ReadonlyArray<readonly [keyof ResolvedPaths, LoadoutResourceType]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedKeys = new Set(allowed);
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isLoadoutResourceType(value: unknown): value is LoadoutResourceType {
	return value === "extension" || value === "skill" || value === "prompt" || value === "theme";
}

function isSafeRelativePath(value: unknown): value is string {
	if (!isNonEmptyString(value) || isAbsolute(value)) return false;
	const segments = value.replace(/\\/g, "/").split("/");
	return !segments.includes("..");
}

function parseReference(value: unknown): LoadoutResourceReference | undefined {
	if (!isRecord(value) || !isLoadoutResourceType(value.type)) return undefined;
	if (value.origin === "package") {
		if (!hasOnlyKeys(value, ["type", "origin", "source", "relativePath"])) return undefined;
		if (!isNonEmptyString(value.source) || !isSafeRelativePath(value.relativePath)) return undefined;
		return {
			type: value.type,
			origin: "package",
			source: value.source,
			relativePath: value.relativePath.replace(/\\/g, "/"),
		};
	}
	if (value.origin !== "top-level") return undefined;
	if (!hasOnlyKeys(value, ["type", "origin", "scope", "relativePath", "path"])) return undefined;
	if (value.scope !== "user" && value.scope !== "project") return undefined;
	if (value.relativePath !== undefined) {
		if (value.path !== undefined || !isSafeRelativePath(value.relativePath)) return undefined;
		return {
			type: value.type,
			origin: "top-level",
			scope: value.scope,
			relativePath: value.relativePath.replace(/\\/g, "/"),
		};
	}
	if (!isNonEmptyString(value.path)) return undefined;
	return { type: value.type, origin: "top-level", scope: value.scope, path: value.path };
}

/** Parse and defensively copy a versioned loadout payload. */
export function parseLoadoutEntryPayload(value: unknown): LoadoutEntryPayload | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ["version", "overrides"])) return undefined;
	if (value.version !== LOADOUT_ENTRY_VERSION || !Array.isArray(value.overrides)) return undefined;
	const overrides: LoadoutOverride[] = [];
	const seen = new Set<string>();
	for (const candidate of value.overrides) {
		if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["reference", "enabled"])) return undefined;
		if (typeof candidate.enabled !== "boolean") return undefined;
		const reference = parseReference(candidate.reference);
		if (!reference) return undefined;
		const key = getLoadoutResourceReferenceKey(reference);
		if (seen.has(key)) return undefined;
		seen.add(key);
		overrides.push({ reference, enabled: candidate.enabled });
	}
	return { version: LOADOUT_ENTRY_VERSION, overrides };
}

export function getLoadoutResourceReferenceKey(reference: LoadoutResourceReference): string {
	return reference.origin === "package"
		? JSON.stringify([reference.type, reference.origin, reference.source, reference.relativePath])
		: JSON.stringify([
				reference.type,
				reference.origin,
				reference.scope,
				reference.relativePath !== undefined ? "relative" : "path",
				reference.relativePath ?? reference.path,
			]);
}

function parseNpmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4).trim();
	const match = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.+)?$/);
	return match?.[1];
}

function canonicalPackageSource(
	source: string,
	scope: LoadoutResourceScope,
	options: ResolveLoadoutOverlayOptions,
): string {
	const npmName = parseNpmPackageName(source);
	if (npmName) return `npm:${npmName}`;
	const git = parseGitUrl(source);
	if (git) return `git:${git.host.toLowerCase()}/${git.path}`;
	if (!isLocalPath(source)) return source.trim();
	const baseDir = scope === "project" ? join(options.cwd, CONFIG_DIR_NAME) : options.agentDir;
	return `local:${canonicalizePath(resolvePath(source, baseDir, { trim: true }))}`;
}

function isPathWithin(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function toRelativeResourcePath(target: string, root: string): string {
	const value = relative(root, target);
	return (value || ".").split(sep).join("/");
}

/** Build a logical reference from a resource already discovered by package/settings resolution. */
export function createLoadoutResourceReference(
	resourceType: LoadoutResourceType,
	resource: ResolvedResource,
	options: ResolveLoadoutOverlayOptions,
): LoadoutResourceReference | undefined {
	const scope = resource.metadata.scope;
	if (scope !== "user" && scope !== "project") return undefined;
	const resourcePath = resolve(resource.path);
	if (resource.metadata.origin === "package") {
		const baseDir = resource.metadata.baseDir ? resolve(resource.metadata.baseDir) : resolve(resource.path, "..");
		if (!isPathWithin(resourcePath, baseDir)) return undefined;
		return {
			type: resourceType,
			origin: "package",
			source: canonicalPackageSource(resource.metadata.source, scope, options),
			relativePath: toRelativeResourcePath(resourcePath, baseDir),
		};
	}
	const standardRoot = resolve(scope === "project" ? join(options.cwd, CONFIG_DIR_NAME) : options.agentDir);
	if (isPathWithin(resourcePath, standardRoot)) {
		return {
			type: resourceType,
			origin: "top-level",
			scope,
			relativePath: toRelativeResourcePath(resourcePath, standardRoot),
		};
	}
	return {
		type: resourceType,
		origin: "top-level",
		scope,
		path: canonicalizePath(resourcePath),
	};
}

function cloneReference(reference: LoadoutResourceReference): LoadoutResourceReference {
	return reference.origin === "package"
		? { ...reference }
		: reference.relativePath !== undefined
			? { type: reference.type, origin: "top-level", scope: reference.scope, relativePath: reference.relativePath }
			: { type: reference.type, origin: "top-level", scope: reference.scope, path: reference.path };
}

export function cloneLoadoutOverrides(overrides: readonly LoadoutOverride[]): LoadoutOverride[] {
	return overrides.map((override) => ({ reference: cloneReference(override.reference), enabled: override.enabled }));
}

export function cloneLoadoutSnapshot(snapshot: LoadoutSnapshot): LoadoutSnapshot {
	return {
		resources: snapshot.resources.map((resource) => ({
			...resource,
			reference: cloneReference(resource.reference),
			metadata: { ...resource.metadata },
		})),
		overrides: cloneLoadoutOverrides(snapshot.overrides),
		diagnostics: snapshot.diagnostics.map((diagnostic) => ({
			...diagnostic,
			collision: diagnostic.collision ? { ...diagnostic.collision } : undefined,
		})),
	};
}

function describeReference(reference: LoadoutResourceReference): string {
	if (reference.origin === "package") return `${reference.source}/${reference.relativePath}`;
	return reference.relativePath ?? reference.path ?? "unknown";
}

/** Apply session overrides only to currently discovered resources. */
export function resolveLoadoutOverlay(
	resolvedPaths: ResolvedPaths,
	overrides: readonly LoadoutOverride[],
	options: ResolveLoadoutOverlayOptions,
): ResolvedLoadoutOverlay {
	const parsed = parseLoadoutEntryPayload({ version: LOADOUT_ENTRY_VERSION, overrides });
	if (!parsed) throw new Error("Invalid loadout overrides");
	const overridesByKey = new Map(
		parsed.overrides.map((override) => [getLoadoutResourceReferenceKey(override.reference), override] as const),
	);
	const unmatchedKeys = new Set(overridesByKey.keys());
	const resources: SelectableLoadoutResource[] = [];
	const overlaid: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] };

	for (const [collection, resourceType] of RESOURCE_COLLECTIONS) {
		for (const resource of resolvedPaths[collection]) {
			const reference = createLoadoutResourceReference(resourceType, resource, options);
			if (!reference) {
				overlaid[collection].push({ ...resource, metadata: { ...resource.metadata } });
				continue;
			}
			const key = getLoadoutResourceReferenceKey(reference);
			const override = overridesByKey.get(key);
			const enabled = override?.enabled ?? resource.enabled;
			if (override) unmatchedKeys.delete(key);
			const metadata = { ...resource.metadata };
			overlaid[collection].push({ path: resource.path, enabled, metadata });
			resources.push({
				reference,
				path: resource.path,
				enabled,
				defaultEnabled: resource.enabled,
				metadata: { ...metadata },
			});
		}
	}

	const diagnostics: ResourceDiagnostic[] = [];
	for (const key of unmatchedKeys) {
		const override = overridesByKey.get(key)!;
		diagnostics.push({
			type: "warning",
			message: `Saved loadout ${override.reference.type} is unavailable: ${describeReference(override.reference)}`,
		});
	}
	return {
		resolvedPaths: overlaid,
		snapshot: { resources, overrides: cloneLoadoutOverrides(parsed.overrides), diagnostics },
	};
}

/** Recover the latest valid loadout entry in physical session-file order. */
export function getLatestLoadoutEntry(entries: readonly SessionEntry[]): LoadoutEntryPayload | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== LOADOUT_CUSTOM_TYPE) continue;
		const payload = parseLoadoutEntryPayload(entry.data);
		if (payload) return payload;
	}
	return undefined;
}

export function getSessionLoadout(sessionManager: Pick<SessionManager, "getEntries">): LoadoutEntryPayload | undefined {
	return getLatestLoadoutEntry(sessionManager.getEntries());
}

export function loadoutOverridesEqual(left: readonly LoadoutOverride[], right: readonly LoadoutOverride[]): boolean {
	if (left.length !== right.length) return false;
	const rightByKey = new Map(
		right.map((override) => [getLoadoutResourceReferenceKey(override.reference), override.enabled]),
	);
	return left.every(
		(override) => rightByKey.get(getLoadoutResourceReferenceKey(override.reference)) === override.enabled,
	);
}

/**
 * Append a deliberate session loadout change.
 * Empty state is written only as a reset marker after a prior non-empty state.
 */
export function appendSessionLoadout(
	sessionManager: Pick<SessionManager, "appendCustomEntry" | "getEntries">,
	overrides: readonly LoadoutOverride[],
): string | undefined {
	const payload = parseLoadoutEntryPayload({ version: LOADOUT_ENTRY_VERSION, overrides });
	if (!payload) throw new Error("Invalid loadout overrides");
	const latest = getLatestLoadoutEntry(sessionManager.getEntries());
	if (payload.overrides.length === 0) {
		if (!latest || latest.overrides.length === 0) return undefined;
	} else if (latest && loadoutOverridesEqual(latest.overrides, payload.overrides)) {
		return undefined;
	}
	return sessionManager.appendCustomEntry(LOADOUT_CUSTOM_TYPE, payload);
}
