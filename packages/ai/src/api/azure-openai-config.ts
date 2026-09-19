import type { Api, Model, StreamOptions } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

const DEFAULT_AZURE_API_VERSION = "v1";

/** Azure models ship without a baseUrl: one resource per user, resolved per request. */
export interface AzureEndpointOptions extends StreamOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
	// can append /deployments/<model>/... and ?api-version=v1 correctly.
	if (
		isAzureHost &&
		(normalizedPath === "" ||
			normalizedPath === "/" ||
			normalizedPath === "/openai" ||
			normalizedPath === "/openai/v1/responses")
	) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	const baseUrl =
		options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim() || undefined;
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return normalizeAzureBaseUrl(resolvedBaseUrl);
}

export function resolveAzureConfig(
	model: Pick<Model<Api>, "baseUrl">,
	options?: AzureEndpointOptions,
): { baseUrl: string; apiVersion: string } {
	return {
		baseUrl: resolveAzureBaseUrl(model, options),
		apiVersion:
			options?.azureApiVersion ||
			getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
			DEFAULT_AZURE_API_VERSION,
	};
}
