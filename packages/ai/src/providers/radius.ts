import { piMessagesApi } from "../api/pi-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadRadiusOAuth } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModels,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
	normalizeRadiusGatewayUrl,
} from "./radius-config.ts";

export interface RadiusProviderOptions {
	id?: string;
	name?: string;
	gateway?: string;
}

/** Radius gateway provider with a persisted, dynamically refreshed catalog. */
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	const id = options.id ?? "radius";
	const name = options.name ?? "Radius";
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	let models = getRadiusModels(id, undefined);
	let inflightRefresh: Promise<void> | undefined;
	const streams = piMessagesApi();

	return {
		id,
		name,
		auth: {
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
			oauth: lazyOAuth({ name, load: () => loadRadiusOAuth({ name, gateway }) }),
		},
		getModels: () => models,
		refreshModels: (context) => {
			inflightRefresh ??= (async () => {
				try {
					const stored = await context.store.read();
					if (stored) models = stored.models.filter((model) => model.provider === id) as typeof models;

					// Import catalogs cached by the pre-ModelsStore Radius implementation.
					if (!stored && context.credential?.type === "oauth") {
						const legacy = getRadiusModels(id, context.credential);
						if (legacy.length > 0) {
							models = legacy;
							await context.store.write({ models: legacy, checkedAt: Date.now() });
						}
					}

					if (!context.allowNetwork || context.signal?.aborted) return;
					const apiKey =
						context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
					const config = await loadRadiusGatewayConfig(gateway, apiKey, context.signal);
					if (context.signal?.aborted) return;
					models = getRadiusModelsFromConfig(id, config);
					await context.store.write({ models, checkedAt: Date.now() });
				} finally {
					inflightRefresh = undefined;
				}
			})();
			return inflightRefresh;
		},
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
