export type ProviderApiKey = string | (() => string | undefined);

export function resolveConfiguredApiKey(rawKey: ProviderApiKey | undefined): string | undefined {
	if (rawKey === undefined) return undefined;
	if (typeof rawKey === "function") return rawKey();
	return rawKey;
}
