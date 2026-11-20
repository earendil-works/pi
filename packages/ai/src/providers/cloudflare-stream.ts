import type { ProviderClassifier, ProviderEnv, ProviderStreams } from "../types.ts";

const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";
const CLOUDFLARE_GATEWAY_DOMAIN = "CLOUDFLARE_GATEWAY_DOMAIN";
const DEFAULT_GATEWAY_PREFIX = `https://gateway.ai.cloudflare.com/v1/{${CLOUDFLARE_ACCOUNT_ID}}/{${CLOUDFLARE_GATEWAY_ID}}`;

function customGatewayPrefix(domain: string): string {
	const value = domain.trim();
	const parsed = URL.parse(value);
	const url = parsed?.protocol === "https:" || parsed?.protocol === "http:" ? parsed : URL.parse(`https://${value}`);
	if (!url) throw new Error(`Invalid CLOUDFLARE_GATEWAY_DOMAIN: ${domain}`);
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.href.replace(/\/$/, "");
}

export function resolveCloudflareModel<TModel extends { baseUrl: string }>(
	model: TModel,
	env: ProviderEnv | undefined,
): TModel {
	if (!env) return model;
	const domain = env[CLOUDFLARE_GATEWAY_DOMAIN];
	const source =
		domain && model.baseUrl.startsWith(DEFAULT_GATEWAY_PREFIX)
			? customGatewayPrefix(domain) + model.baseUrl.slice(DEFAULT_GATEWAY_PREFIX.length)
			: model.baseUrl;
	const baseUrl = source
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

/**
 * Wrap an API implementation so Cloudflare account/gateway endpoint
 * placeholders materialize from the resolved provider env before dispatch.
 */
export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			streams.stream(resolveCloudflareModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}

/** Classifier counterpart of {@link cloudflareStreams}. */
export function cloudflareClassifier(classifier: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) =>
			classifier.classify(resolveCloudflareModel(model, options?.env), context, options),
	};
}
