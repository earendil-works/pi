import type { OAuthCredential } from "../auth/types.ts";
import type { ClassifierModel, Model, ThinkingLevelMap } from "../types.ts";
import { ownedSlice } from "../utils/text.ts";

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

export type RadiusGatewayClassifierModel = {
	id: string;
	name: string;
	input: ("text" | "image")[];
	cost: ClassifierModel<"pi-decision">["cost"];
	contextWindow: number;
};

export type RadiusGatewayConfig = {
	baseUrl: string;
	models: RadiusGatewayModel[];
	classifiers?: RadiusGatewayClassifierModel[];
};

export type RadiusOAuthCredential = OAuthCredential & {
	gatewayConfig?: RadiusGatewayConfig;
};

function isRadiusGatewayClassifierModel(value: unknown): value is RadiusGatewayClassifierModel {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const model = value as Partial<RadiusGatewayClassifierModel>;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		Array.isArray(model.input) &&
		typeof model.cost === "object" &&
		model.cost !== null &&
		!Array.isArray(model.cost) &&
		typeof model.contextWindow === "number"
	);
}

function isRadiusGatewayModel(value: unknown): value is RadiusGatewayModel {
	if (!isRadiusGatewayClassifierModel(value)) return false;
	const model = value as Partial<RadiusGatewayModel>;
	return typeof model.reasoning === "boolean" && typeof model.maxTokens === "number";
}

function sanitizeRadiusGatewayConfig(config: unknown): RadiusGatewayConfig | undefined {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
	const { baseUrl, models, classifiers } = config as Partial<RadiusGatewayConfig>;
	if (typeof baseUrl !== "string" || !Array.isArray(models)) return undefined;
	return {
		baseUrl,
		models: models.filter(isRadiusGatewayModel).map((model) => ({ ...model })),
		...(Array.isArray(classifiers)
			? { classifiers: classifiers.filter(isRadiusGatewayClassifierModel).map((model) => ({ ...model })) }
			: {}),
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

export function getRadiusAllModelsFromConfig(
	providerId: string,
	config: RadiusGatewayConfig,
): (Model<"pi-messages"> | ClassifierModel<"pi-decision">)[] {
	return [
		...getRadiusModelsFromConfig(providerId, config),
		...(config.classifiers ?? []).map(
			(model): ClassifierModel<"pi-decision"> => ({
				...model,
				type: "classifier",
				api: "pi-decision",
				provider: providerId,
				baseUrl: config.baseUrl,
			}),
		),
	];
}

export function getRadiusModels(providerId: string, credential: OAuthCredential | undefined): Model<"pi-messages">[] {
	const config = getRadiusCredentialConfig(credential);
	return config ? getRadiusModelsFromConfig(providerId, config) : [];
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${ownedSlice(trimmed, 0, 512)}…` : trimmed;
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
