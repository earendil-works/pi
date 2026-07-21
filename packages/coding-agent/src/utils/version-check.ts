import { compare, valid } from "semver";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

/** Network error codes that are usually worth a single immediate retry. */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
	"EAI_AGAIN",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

function collectErrorCodes(error: unknown, depth = 0, codes: string[] = []): string[] {
	if (depth > 4 || error === undefined || error === null) {
		return codes;
	}
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		codes.push(error.code);
	}
	if (error instanceof AggregateError) {
		for (const nested of error.errors) {
			collectErrorCodes(nested, depth + 1, codes);
		}
	}
	if (error instanceof Error && error.cause !== undefined) {
		collectErrorCodes(error.cause, depth + 1, codes);
	}
	return codes;
}

/**
 * True for connection-setup / transport failures that often succeed on an immediate retry.
 * Used by self-update; startup version checks stay fail-soft and do not retry.
 */
export function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	if (error.name === "TimeoutError" || error.name === "AbortError") {
		return true;
	}
	if (error.message === "fetch failed" || /\b(ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN)\b/.test(error.message)) {
		return true;
	}
	return collectErrorCodes(error).some((code) => TRANSIENT_NETWORK_ERROR_CODES.has(code));
}

/** Flatten message + errno codes + cause chain for user-facing update errors. */
export function formatNetworkErrorDetails(error: unknown, depth = 0): string {
	if (depth > 4) {
		return "...";
	}
	if (!(error instanceof Error)) {
		return String(error);
	}

	const parts: string[] = [error.message];
	if ("code" in error && typeof error.code === "string" && error.code) {
		parts.push(`code=${error.code}`);
	}
	if (error instanceof AggregateError && error.errors.length > 0) {
		const nested = error.errors.map((nestedError) => formatNetworkErrorDetails(nestedError, depth + 1)).join("; ");
		parts.push(`errors=[${nested}]`);
	} else if (error.cause !== undefined) {
		parts.push(`cause=${formatNetworkErrorDetails(error.cause, depth + 1)}`);
	}
	return parts.join("; ");
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

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
