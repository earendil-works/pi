import { compare, valid } from "semver";

// Version check against pi.dev is DISABLED for the MatwingsVenus distribution.
// The fork does not phone home to pi.dev and does not prompt the user about
// upstream pi releases. The public signatures are preserved so callers compile
// unchanged; the comparison helpers are retained for local self-update tooling.

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export interface VersionCheckOptions {
	timeoutMs?: number;
	retry?: boolean;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find((value): value is Error => value instanceof Error && Boolean(value.message))
		?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/** Disabled in the MatwingsVenus distribution — never reaches the network. */
export async function getLatestPiRelease(
	_currentVersion?: string,
	_options?: VersionCheckOptions,
): Promise<LatestPiRelease | undefined> {
	return undefined;
}

/** Disabled in the MatwingsVenus distribution — never reaches the network. */
export async function getLatestPiVersion(
	_currentVersion?: string,
	_options?: VersionCheckOptions,
): Promise<string | undefined> {
	return undefined;
}

/** Disabled in the MatwingsVenus distribution — never reaches the network. */
export async function checkForNewPiVersion(
	_currentVersion?: string,
): Promise<LatestPiRelease | undefined> {
	return undefined;
}
