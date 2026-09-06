/**
 * Parse and resolve opt-in `retry.fallbackChains` entries.
 *
 * Each chain is an ordered list of `provider/modelId` refs. Model IDs may
 * contain slashes; the first slash separates provider from model.
 */

export interface FallbackModelRef {
	provider: string;
	modelId: string;
}

export function parseFallbackModelRef(value: string): FallbackModelRef | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) {
		return undefined;
	}
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) {
		return undefined;
	}
	return { provider, modelId };
}

export function parseFallbackChains(value: unknown): FallbackModelRef[][] {
	if (!Array.isArray(value)) {
		return [];
	}

	const chains: FallbackModelRef[][] = [];
	for (const chain of value) {
		if (!Array.isArray(chain)) {
			continue;
		}
		const refs: FallbackModelRef[] = [];
		for (const entry of chain) {
			if (typeof entry !== "string") {
				continue;
			}
			const ref = parseFallbackModelRef(entry);
			if (ref) {
				refs.push(ref);
			}
		}
		if (refs.length >= 2) {
			chains.push(refs);
		}
	}
	return chains;
}

export function fallbackModelRefKey(ref: FallbackModelRef): string {
	return `${ref.provider}/${ref.modelId}`.toLowerCase();
}

/** Remaining hops after the current model in the first matching chain. */
export function findNextFallbackRefs(
	current: FallbackModelRef,
	chains: readonly FallbackModelRef[][],
): FallbackModelRef[] {
	const currentKey = fallbackModelRefKey(current);
	for (const chain of chains) {
		const index = chain.findIndex((ref) => fallbackModelRefKey(ref) === currentKey);
		if (index === -1) {
			continue;
		}
		return chain.slice(index + 1);
	}
	return [];
}
