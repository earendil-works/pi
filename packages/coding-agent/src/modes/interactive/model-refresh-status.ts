import type { BoundedRefreshResult } from "../../core/model-runtime.ts";

export function formatModelRefreshWarning(result: BoundedRefreshResult, fallback: string): string | undefined {
	if (result.timedOut) return `Model refresh timed out; ${fallback}`;
	if (result.errors.size === 1) {
		return `Could not refresh ${result.errors.keys().next().value}; ${fallback}`;
	}
	if (result.errors.size > 1) {
		return `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); ${fallback}`;
	}
	return undefined;
}
