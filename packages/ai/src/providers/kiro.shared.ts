import type { KiroModel } from "./kiro.catalog.ts";

/** AWS SSO regions that map to Kiro's two currently-served API regions. */
const API_REGION_MAP: Record<string, string> = {
	"us-west-1": "us-east-1",
	"us-west-2": "us-east-1",
	"us-east-2": "us-east-1",
	"ap-southeast-1": "us-east-1",
	"ap-southeast-2": "us-east-1",
	"ap-northeast-1": "us-east-1",
	"ap-south-1": "us-east-1",
	"eu-west-1": "eu-central-1",
	"eu-west-2": "eu-central-1",
	"eu-west-3": "eu-central-1",
	"eu-north-1": "eu-central-1",
	"eu-south-1": "eu-central-1",
	"eu-south-2": "eu-central-1",
	"eu-central-2": "eu-central-1",
};

export interface KiroEndpoints {
	region: string;
	management: string;
	runtime: string;
}

export function resolveKiroApiRegion(ssoRegion?: string): string {
	const normalized = ssoRegion?.trim();
	return normalized ? (API_REGION_MAP[normalized] ?? normalized) : "us-east-1";
}

export function getKiroEndpoints(region: string): KiroEndpoints {
	return {
		region,
		management: `https://management.${region}.kiro.dev/`,
		runtime: `https://runtime.${region}.kiro.dev/`,
	};
}

export function getKiroRegionFromEndpoint(endpoint: string | undefined): string | undefined {
	if (!endpoint) return undefined;
	try {
		const [service, region, ...suffix] = new URL(endpoint).hostname.split(".");
		if ((service === "management" || service === "runtime") && suffix.join(".") === "kiro.dev") {
			return region;
		}
	} catch {
		// The model may have a custom or incomplete base URL. The caller falls back
		// to the default Kiro region in that case.
	}
	return undefined;
}

export interface KiroManagementAuth {
	accessToken: string;
	region: string;
}

export interface KiroCatalogModel {
	modelId: string;
	displayName?: string;
	tokenLimits?: {
		maxInputTokens?: number;
		maxOutputTokens?: number;
		[key: string]: unknown;
	};
	additionalModelRequestFieldsSchema?: Record<string, unknown> | null;
	[key: string]: unknown;
}

export interface KiroListAvailableModelsResponse {
	models: KiroCatalogModel[];
	[key: string]: unknown;
}

export class KiroManagementHttpError extends Error {
	readonly status: number;

	constructor(operation: string, region: string, status: number) {
		super(`Kiro management ${operation} failed in ${region}: HTTP ${status}`);
		this.name = "KiroManagementHttpError";
		this.status = status;
	}
}

async function managementRequest<TResponse>(
	auth: KiroManagementAuth,
	operation: string,
	path: string,
	method: "GET" | "POST",
	params: Record<string, string | undefined>,
	fetchFn: typeof globalThis.fetch,
	signal?: AbortSignal,
): Promise<TResponse> {
	const url = new URL(path, getKiroEndpoints(auth.region).management);
	const request: RequestInit = {
		method,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${auth.accessToken}`,
		},
		signal,
	};
	if (method === "GET") {
		for (const [name, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(name, value);
		}
	} else {
		request.headers = { ...request.headers, "Content-Type": "application/json" };
		request.body = JSON.stringify(
			Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)),
		);
	}

	let response: Response;
	try {
		response = await fetchFn(url, request);
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(`Kiro management ${operation} request failed in ${auth.region}`, { cause: error });
	}
	if (!response.ok) throw new KiroManagementHttpError(operation, auth.region, response.status);
	try {
		return (await response.json()) as TResponse;
	} catch (error) {
		throw new Error(`Kiro management ${operation} returned invalid JSON in ${auth.region}`, { cause: error });
	}
}

export async function resolveKiroProfileArn(
	auth: KiroManagementAuth,
	providedProfileArn: string | undefined,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	signal?: AbortSignal,
): Promise<string> {
	if (providedProfileArn) return providedProfileArn;
	const response = await managementRequest<{ profiles?: Array<{ arn?: string }> }>(
		auth,
		"ListAvailableProfiles",
		"List-Available-Profiles",
		"POST",
		{},
		fetchFn,
		signal,
	);
	const profileArn = response.profiles?.find(
		(profile) => typeof profile.arn === "string" && profile.arn.length > 0,
	)?.arn;
	if (!profileArn) {
		throw new Error(`Kiro management ListAvailableProfiles returned no profile in ${auth.region}`);
	}
	return profileArn;
}

export async function fetchKiroModelCatalog(
	auth: KiroManagementAuth,
	providedProfileArn?: string,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	signal?: AbortSignal,
): Promise<{ profileArn: string; response: KiroListAvailableModelsResponse }> {
	const profileArn = await resolveKiroProfileArn(auth, providedProfileArn, fetchFn, signal);
	const response = await managementRequest<KiroListAvailableModelsResponse>(
		auth,
		"ListAvailableModels",
		"List-Available-Models",
		"GET",
		{ origin: "KIRO_CLI", profileArn },
		fetchFn,
		signal,
	);
	if (!Array.isArray(response.models) || response.models.length === 0) {
		throw new Error(`Kiro management ListAvailableModels returned no models in ${auth.region}`);
	}
	if (response.models.some((model) => !model || typeof model.modelId !== "string" || model.modelId.length === 0)) {
		throw new Error(`Kiro management ListAvailableModels returned an invalid catalog in ${auth.region}`);
	}
	return { profileArn, response };
}

export function mapKiroCatalogModels(catalog: readonly KiroCatalogModel[], region: string): KiroModel[] {
	const seen = new Set<string>();
	return catalog.map((model) => {
		const id = model.modelId.trim();
		if (!id || seen.has(id)) throw new Error(`Kiro management catalog contains duplicate model ID ${id}`);
		seen.add(id);
		const normalizedName = model.displayName?.trim() || id;
		const limits = model.tokenLimits;
		const reasoning =
			model.additionalModelRequestFieldsSchema !== undefined || /auto|claude|deepseek|gpt|glm|qwen/i.test(id);
		const result: KiroModel = {
			id,
			name: normalizedName,
			api: "kiro-api",
			provider: "kiro",
			baseUrl: getKiroEndpoints(region).runtime,
			reasoning,
			input: /^(claude|auto)/i.test(id) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: limits?.maxInputTokens ?? 200_000,
			maxTokens: limits?.maxOutputTokens ?? 8_192,
			kiroModelId: id,
			kiroRegion: region,
			...(model.additionalModelRequestFieldsSchema
				? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
				: {}),
		};
		return result;
	});
}
