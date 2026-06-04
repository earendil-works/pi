const PROVIDER_NAME_ALIASES: Record<string, string> = {
	firepass: "fireworks",
};

export function normalizeProviderName(provider: string): string {
	return PROVIDER_NAME_ALIASES[provider.toLowerCase()] ?? provider;
}

export function normalizeProviderInModelReference(reference: string): string {
	const slashIndex = reference.indexOf("/");
	if (slashIndex === -1) {
		return reference;
	}

	const provider = reference.substring(0, slashIndex);
	const normalizedProvider = normalizeProviderName(provider);
	if (normalizedProvider === provider) {
		return reference;
	}

	return `${normalizedProvider}${reference.substring(slashIndex)}`;
}
