import type { ProviderEnv, ProviderHeaders } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export interface BedrockMantleAuthOptions {
	region?: string;
	profile?: string;
	/** Bearer token auth for Bedrock. If omitted, a short-term token is generated from the AWS credential chain. */
	bearerToken?: string;
	/** For Bedrock Mantle wrappers, apiKey is treated as a Bedrock bearer token. */
	apiKey?: string;
	env?: ProviderEnv;
	headers?: ProviderHeaders;
	fetch?: typeof globalThis.fetch;
}

export type BedrockMantleAuth =
	| {
			type: "bearer";
			baseUrl: string;
			token: string;
			headers: ProviderHeaders;
	  }
	| {
			type: "short-term-token";
			baseUrl: string;
			apiKey: string;
			headers: ProviderHeaders;
			fetch: typeof globalThis.fetch;
	  };

export interface PrepareBedrockMantleAuthParams {
	modelBaseUrl?: string;
	headers?: ProviderHeaders;
	baseUrlForRegion(region: string): string;
	regionFromBaseUrl?(baseUrl: string | undefined): string | undefined;
	fallbackRegion?: string;
	dummyApiKey?: string;
}

const FALLBACK_REGION = "us-east-1";
const DUMMY_API_KEY = "aws-short-term-token";

export function getRegionFromBedrockMantleBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	const match = baseUrl.match(/^https:\/\/bedrock-mantle\.([a-z0-9-]+)\.api\.aws(?:\/|$)/);
	return match?.[1];
}

async function loadTokenGenerator() {
	try {
		const { getTokenProvider } = await import("@aws/bedrock-token-generator");
		return { getTokenProvider };
	} catch (error) {
		throw new Error(
			"AWS credential-chain auth for Amazon Bedrock Mantle APIs requires the optional peer dependency " +
				"@aws/bedrock-token-generator. Install it, or set AWS_BEARER_TOKEN_BEDROCK to use bearer-token auth.",
			{ cause: error },
		);
	}
}

function getBearerToken(options?: BedrockMantleAuthOptions): string | undefined {
	return (
		options?.bearerToken ||
		options?.apiKey ||
		getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options?.env) ||
		undefined
	);
}

function getProfile(options?: Pick<BedrockMantleAuthOptions, "profile" | "env">): string | undefined {
	return options?.profile || getProviderEnvValue("AWS_PROFILE", options?.env);
}

function getStaticCredentials(options?: Pick<BedrockMantleAuthOptions, "env">) {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", options?.env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", options?.env);
	if (!accessKeyId || !secretAccessKey) return undefined;
	return {
		accessKeyId,
		secretAccessKey,
		sessionToken: getProviderEnvValue("AWS_SESSION_TOKEN", options?.env),
	};
}

function createShortTermTokenFetch(options: BedrockMantleAuthOptions | undefined, region: string): typeof fetch {
	const baseFetch = options?.fetch ?? globalThis.fetch;
	let provideTokenPromise: Promise<() => Promise<string>> | undefined;
	const getProvider = () => {
		provideTokenPromise ??= (async () => {
			const { getTokenProvider } = await loadTokenGenerator();
			return getTokenProvider({
				region,
				...(getProfile(options) ? { profile: getProfile(options) } : {}),
				...(getStaticCredentials(options) ? { credentials: getStaticCredentials(options) } : {}),
			});
		})();
		return provideTokenPromise;
	};

	return async (input, init) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set("authorization", `Bearer ${await (await getProvider())()}`);
		headers.delete("x-api-key");
		return baseFetch(request, { headers });
	};
}

function resolveRegion(options: BedrockMantleAuthOptions | undefined, params: PrepareBedrockMantleAuthParams): string {
	return (
		options?.region ||
		params.regionFromBaseUrl?.(params.modelBaseUrl) ||
		getProviderEnvValue("AWS_REGION", options?.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options?.env) ||
		params.fallbackRegion ||
		FALLBACK_REGION
	);
}

export function prepareBedrockMantleAuth(
	options: BedrockMantleAuthOptions | undefined,
	params: PrepareBedrockMantleAuthParams,
): BedrockMantleAuth {
	const region = resolveRegion(options, params);
	const baseUrl = params.baseUrlForRegion(region);
	const headers: ProviderHeaders = { ...params.headers, ...options?.headers };
	const bearerToken = getBearerToken(options);

	if (bearerToken) {
		return { type: "bearer", baseUrl, token: bearerToken, headers };
	}

	return {
		type: "short-term-token",
		baseUrl,
		apiKey: params.dummyApiKey ?? DUMMY_API_KEY,
		headers,
		fetch: createShortTermTokenFetch(options, region),
	};
}
