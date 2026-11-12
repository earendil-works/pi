import type { ProviderEnv, ProviderStreams } from "../types.ts";

const NEON_AI_GATEWAY_BASE_URL_ENV = "NEON_AI_GATEWAY_BASE_URL";

/** Branch host placeholder in Neon AI Gateway model base URLs, e.g. `{NEON_AI_GATEWAY_BASE_URL}/v1`. */
export const NEON_AI_GATEWAY_BASE_URL = `{${NEON_AI_GATEWAY_BASE_URL_ENV}}`;

function resolveNeonModel<TModel extends { baseUrl: string }>(model: TModel, env: ProviderEnv | undefined): TModel {
	const host = env?.[NEON_AI_GATEWAY_BASE_URL_ENV]?.replace(/\/+$/, "");
	if (!host || !model.baseUrl.includes(NEON_AI_GATEWAY_BASE_URL)) return model;
	return { ...model, baseUrl: model.baseUrl.replaceAll(NEON_AI_GATEWAY_BASE_URL, host) };
}

/** Wrap an API implementation so the branch host placeholder resolves from provider env before dispatch. */
export function neonAIGatewayStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) => streams.stream(resolveNeonModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveNeonModel(model, options?.env), context, options),
	};
}
