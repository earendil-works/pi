/** Match provider IDs and display names exactly, ignoring case and surrounding whitespace in the reference. */
export function findMatchingProviders<T extends { id: string; name: string }>(
	providers: readonly T[],
	providerRef: string,
): T[] {
	const normalized = providerRef.trim().toLowerCase();
	if (!normalized) return [];
	return providers.filter(
		(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
	);
}
