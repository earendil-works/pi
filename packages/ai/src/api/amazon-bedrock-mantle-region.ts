import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

const AWS_REGION_PLACEHOLDER = `\${AWS_REGION}`;
const DEFAULT_REGION = "us-east-2";

// The first region is the deterministic fallback.
// https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html
const MODEL_REGIONS: Record<string, readonly string[]> = {
	"openai.gpt-5.4": ["us-east-2", "us-east-1", "us-west-2", "us-gov-west-1"],
	"openai.gpt-5.5": ["us-east-2", "us-east-1"],
	"openai.gpt-5.6-sol": ["us-east-2", "us-east-1"],
	"openai.gpt-5.6-terra": ["us-east-2", "us-east-1", "us-west-2"],
	"openai.gpt-5.6-luna": ["us-east-2", "us-east-1", "us-west-2"],
	"xai.grok-4.3": ["us-east-2", "us-east-1", "us-west-2"],
};

function getStandardRegionFromHost(baseUrl: string): string | undefined {
	try {
		const { hostname } = new URL(baseUrl);
		return hostname.toLowerCase().match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/)?.[1];
	} catch {
		return undefined;
	}
}

export function resolveBedrockMantleEndpoint(
	modelId: string,
	baseUrl: string,
	options?: { region?: string; env?: ProviderEnv },
): { baseUrl: string; region: string | undefined } {
	const endpointRegion = getStandardRegionFromHost(baseUrl);
	if (endpointRegion) return { baseUrl, region: endpointRegion };

	const requestedRegion =
		options?.region?.trim() ||
		getProviderEnvValue("AWS_REGION", options?.env)?.trim() ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options?.env)?.trim() ||
		undefined;
	if (!baseUrl.includes(AWS_REGION_PLACEHOLDER)) return { baseUrl, region: requestedRegion };

	const supportedRegions = MODEL_REGIONS[modelId];
	const region =
		requestedRegion && (!supportedRegions || supportedRegions.includes(requestedRegion))
			? requestedRegion
			: (supportedRegions?.[0] ?? requestedRegion ?? DEFAULT_REGION);
	return { baseUrl: baseUrl.replaceAll(AWS_REGION_PLACEHOLDER, region), region };
}
