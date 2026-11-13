/**
 * Preferred partner providers and the order provider lists show them in. Kept free of UI code so the list can move
 * to pi-ai once provider lists are offered there.
 */

import { RADIUS_PROVIDER_ID } from "./radius.ts";

/** Ids of the preferred partner providers, most preferred first. */
export const PREFERRED_PROVIDER_IDS: readonly string[] = [RADIUS_PROVIDER_ID, "openrouter"];

/** Whether the provider is a preferred partner. */
export function isPreferredProvider(providerId: string): boolean {
	return PREFERRED_PROVIDER_IDS.includes(providerId);
}

/** Orders providers: preferred partners first, in their order, then all others alphabetically by name. */
export function compareProviders(a: { id: string; name: string }, b: { id: string; name: string }): number {
	const rankA = preferredRank(a.id);
	const rankB = preferredRank(b.id);
	if (rankA !== rankB) return rankA - rankB;
	return a.name.localeCompare(b.name);
}

function preferredRank(providerId: string): number {
	const index = PREFERRED_PROVIDER_IDS.indexOf(providerId);
	return index === -1 ? PREFERRED_PROVIDER_IDS.length : index;
}
