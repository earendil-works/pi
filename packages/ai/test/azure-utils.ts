/**
 * Utility functions for Azure OpenAI tests
 */

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function hasAzureOpenAICredentials(): boolean {
	const hasAuth = !!process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_AUTH_MODE === "entra-id";
	const hasBaseUrl = !!(process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_RESOURCE_NAME);
	return hasAuth && hasBaseUrl;
}

export function resolveAzureDeploymentName(modelId: string): string | undefined {
	const mapValue = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	if (!mapValue) return undefined;
	return parseDeploymentNameMap(mapValue).get(modelId);
}
