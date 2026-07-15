import type { OAuthCredential } from "../auth/types.ts";
import type { Model, ThinkingLevelMap } from "../types.ts";

export const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";

export type RadiusGatewayModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: Model<"pi-messages">["cost"];
	contextWindow: number;
	maxTokens: number;
};

export type RadiusGatewayConfig = {
	baseUrl: string;
	models: RadiusGatewayModel[];
};

export type RadiusOAuthCredential = OAuthCredential & {
	gatewayConfig?: RadiusGatewayConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRadiusGatewayModel(value: unknown): value is RadiusGatewayModel {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.reasoning === "boolean" &&
		Array.isArray(value.input) &&
		isRecord(value.cost) &&
		typeof value.contextWindow === "number" &&
		typeof value.maxTokens === "number"
	);
}

function sanitizeRadiusGatewayConfig(config: unknown): RadiusGatewayConfig | undefined {
	if (!isRecord(config) || typeof config.baseUrl !== "string" || !Array.isArray(config.models)) return undefined;
	return {
		baseUrl: config.baseUrl,
		models: config.models.filter(isRadiusGatewayModel).map((model) => ({ ...model })),
	};
}

export function normalizeRadiusGatewayUrl(value: string): string {
	const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
	return withScheme.replace(/\/+$/u, "");
}

export function getRadiusCredentialConfig(credential: OAuthCredential | undefined): RadiusGatewayConfig | undefined {
	return sanitizeRadiusGatewayConfig((credential as RadiusOAuthCredential | undefined)?.gatewayConfig);
}

export function getRadiusModelsFromConfig(providerId: string, config: RadiusGatewayConfig): Model<"pi-messages">[] {
	return config.models.map((model) => ({
		...model,
		api: "pi-messages",
		provider: providerId,
		baseUrl: config.baseUrl,
	}));
}

export function getRadiusModels(providerId: string, credential: OAuthCredential | undefined): Model<"pi-messages">[] {
	const config = getRadiusCredentialConfig(credential);
	return config ? getRadiusModelsFromConfig(providerId, config) : [];
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

export async function loadRadiusGatewayConfig(
	gateway: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<RadiusGatewayConfig> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(new URL("/v1/config", gateway), { headers, signal });
	if (!response.ok) {
		throw new Error(
			`Could not load Radius config from ${gateway}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	const config = sanitizeRadiusGatewayConfig(await response.json());
	if (!config) throw new Error(`Invalid Radius config from ${gateway}`);
	return config;
}
