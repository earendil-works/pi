/**
 * Utility functions for Azure AI Foundry tests
 */

/**
 * Check if Azure AI Foundry credentials are available.
 *
 * API key auth (Option A): ANTHROPIC_FOUNDRY_API_KEY + endpoint
 * Entra ID auth (Option B): endpoint only (DefaultAzureCredential via az login / service principal)
 */
export function hasFoundryCredentials(): boolean {
	const hasEndpoint = !!(process.env.ANTHROPIC_FOUNDRY_RESOURCE || process.env.ANTHROPIC_FOUNDRY_BASE_URL);
	if (!hasEndpoint) return false;
	// Either an explicit API key or ambient Entra ID creds (client id/secret, az login, managed identity)
	const hasApiKey = !!process.env.ANTHROPIC_FOUNDRY_API_KEY;
	const hasEntraCreds = !!(process.env.AZURE_CLIENT_ID || process.env.MSI_ENDPOINT || process.env.IDENTITY_ENDPOINT);
	return hasApiKey || hasEntraCreds;
}

/**
 * Resolve the default Foundry model to use in tests.
 * Override with FOUNDRY_TEST_MODEL env var.
 */
export function resolveFoundryTestModel(): string {
	return process.env.FOUNDRY_TEST_MODEL ?? "claude-opus-4-8";
}
