import type { PathMetadata } from "./package-manager.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	changelogPath?: string;
}

export interface SourcePackageIdentity {
	source: string;
	scope: SourceScope;
}

export function getSourcePackageKey(identity: SourcePackageIdentity): string {
	return JSON.stringify({
		source: identity.source,
		scope: identity.scope,
	});
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
		...(metadata.changelogPath ? { changelogPath: metadata.changelogPath } : {}),
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
		changelogPath?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
		...(options.changelogPath ? { changelogPath: options.changelogPath } : {}),
	};
}
