import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog } from "../api/antigravity/client.ts";
import {
	buildAntigravityCatalog,
	comparePublicModels,
	humanizePublicId,
	isFamilyVersionMismatch,
} from "../api/antigravity/grouping.ts";
import { ANTIGRAVITY_MODEL_ENUM, ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from "../api/antigravity/models.ts";
import type { AntigravityRouting } from "../api/antigravity/types.ts";
import { antigravityEnv } from "../api/antigravity/util.ts";
import { antigravityApi } from "../api/antigravity-api.ts";
import { generateImages } from "../api/antigravity-images.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { ImageModel, Model } from "../types.ts";

export type AntigravityModel = Model<"antigravity-api"> & {
	antigravityModelEnum?: string;
	antigravityRouting?: AntigravityRouting;
	antigravityModelEnums?: Record<string, string>;
};

type AntigravityProviderModel = AntigravityModel | ImageModel<"antigravity-images">;

/** Google-account subscription access, independent of coding-agent extensions. */
export function antigravityProvider(): Provider<"antigravity-api"> {
	const baseline: AntigravityModel[] = ANTIGRAVITY_MODELS.map((model) => ({
		...model,
		api: "antigravity-api",
		provider: "antigravity",
		baseUrl: DEFAULT_ENDPOINT,
	}));
	const imageBaseline: ImageModel<"antigravity-images">[] = [
		"gemini-3-pro-image",
		"gemini-3.1-flash-image",
		"gemini-3-pro-image-preview",
	].map((id) => ({
		type: "image",
		id,
		name: `${humanizePublicId(id)} (Antigravity)`,
		api: "antigravity-images",
		provider: "antigravity",
		baseUrl: DEFAULT_ENDPOINT,
		input: ["text"],
		output: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	let models: AntigravityProviderModel[] = [...baseline, ...imageBaseline];
	const oauth = lazyOAuth({ name: "Antigravity (Google account)", isSubscription: true, load: loadAntigravityOAuth });
	const provider = createProvider({
		id: "antigravity",
		name: "Antigravity",
		baseUrl: DEFAULT_ENDPOINT,
		auth: { oauth },
		models,
		api: antigravityApi(),
		images: { "antigravity-images": { generateImages } },
	});
	return {
		...provider,
		getModels: () => models.filter((model): model is AntigravityModel => isModelType(model, "chat")),
		getAllModels: () => models,
		async refreshModels(context) {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is AntigravityProviderModel =>
						model.provider === "antigravity" &&
						((isModelType(model, "chat") && model.api === "antigravity-api") ||
							(isModelType(model, "image") && model.api === "antigravity-images")),
				);
				if (restored.length) {
					const baselineByKey = new Map<string, AntigravityProviderModel>(
						[...baseline, ...imageBaseline].map((model) => [`${model.type ?? "chat"}:${model.id}`, model]),
					);
					const published = await context.publish({
						update: () => {
							const merged = new Map<string, AntigravityProviderModel>(baselineByKey);
							for (const model of restored) {
								const key = `${model.type ?? "chat"}:${model.id}`;
								const base = baselineByKey.get(key);
								if (base && isModelType(base, "chat") && isModelType(model, "chat")) {
									merged.set(key, {
										...model,
										name: base.name,
										cost: base.cost,
										contextWindow: Math.max(base.contextWindow, model.contextWindow ?? 0),
										maxTokens: Math.max(base.maxTokens, model.maxTokens ?? 0),
										reasoning: base.reasoning,
										thinkingLevelMap: base.thinkingLevelMap,
										antigravityRouting: model.antigravityRouting ?? ANTIGRAVITY_ROUTING[base.id],
									});
								} else if (isModelType(model, "chat")) {
									const versionMismatch = isFamilyVersionMismatch(model.id, model.name);
									const repairedName = versionMismatch
										? `${humanizePublicId(model.id)} (Antigravity)`
										: model.name;
									merged.set(key, {
										...model,
										name: repairedName,
									});
								} else if (base && isModelType(base, "image") && isModelType(model, "image")) {
									merged.set(key, {
										...base,
										...model,
										api: "antigravity-images",
										provider: "antigravity",
										baseUrl: DEFAULT_ENDPOINT,
									});
								} else {
									merged.set(key, model);
								}
							}
							const chatModels = [...merged.values()].filter((m): m is AntigravityModel =>
								isModelType(m, "chat"),
							);
							const imageModels = [...merged.values()].filter((m): m is ImageModel<"antigravity-images"> =>
								isModelType(m, "image"),
							);
							const restoredEnums = Object.assign(
								{},
								...restored
									.map((m) => ("antigravityModelEnums" in m ? m.antigravityModelEnums : undefined))
									.filter(Boolean),
							);
							const combinedEnums = {
								...restoredEnums,
								...ANTIGRAVITY_MODEL_ENUM,
							};
							for (const model of chatModels) {
								if (!model.antigravityRouting) {
									model.antigravityRouting = ANTIGRAVITY_ROUTING[model.id] ?? {
										defaultRequestId: model.id,
										off: model.id,
										routing: { low: model.id, high: model.id },
									};
								}
								model.antigravityModelEnums = {
									...(model.antigravityModelEnums ?? {}),
									...combinedEnums,
								};
							}
							chatModels.sort(comparePublicModels);
							models = [...chatModels, ...imageModels];
						},
					});
					if (!published) return;
				}
			}
			if (!context.allowNetwork || context.credential?.type !== "oauth") return;
			const configuredInterval = Number.parseInt(
				antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS") ?? "",
				10,
			);
			const refreshInterval =
				Number.isFinite(configuredInterval) && configuredInterval >= 0 ? configuredInterval : 4 * 60 * 60 * 1000;
			const checkedAt = context.stored?.checkedAt ?? 0;
			const now = Date.now();
			if (!context.force && checkedAt > 0 && now >= checkedAt && now - checkedAt < refreshInterval) return;
			const auth = await oauth.toAuth(context.credential);
			const credential = JSON.parse(auth.apiKey!) as { token: string; projectId: string };
			const catalog = await fetchAvailableModelsCatalog(credential.token, credential.projectId, {
				signal: context.signal,
			});
			// Empty discovery is not a new catalog: preserve models, routes, enums, and freshness.
			if (!catalog.models || Object.keys(catalog.models).length === 0) return;
			const grouped = buildAntigravityCatalog(catalog.models, {
				models: baseline,
				routing: ANTIGRAVITY_ROUTING,
			});
			const enums = {
				...ANTIGRAVITY_MODEL_ENUM,
				...Object.fromEntries(
					Object.entries(catalog.models ?? {}).flatMap(([id, info]) =>
						typeof info.model === "string" ? [[id, info.model]] : [],
					),
				),
			};
			const images = new Map(imageBaseline.map((model) => [model.id, model]));
			for (const [id, info] of Object.entries(catalog.models ?? {})) {
				if (
					info.isInternal ||
					id.length > 80 ||
					!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)
				)
					continue;
				images.set(id, {
					...imageBaseline[0]!,
					id,
					name: typeof info.displayName === "string" ? info.displayName : `${humanizePublicId(id)} (Antigravity)`,
					input: info.supportsImages === true ? ["text", "image"] : ["text"],
				});
			}
			const next: AntigravityProviderModel[] = grouped.models.map((model) => ({
				...model,
				api: "antigravity-api",
				provider: "antigravity",
				baseUrl: DEFAULT_ENDPOINT,
				antigravityRouting: grouped.routing[model.id],
				antigravityModelEnums: enums,
			}));
			next.push(...images.values());
			await context.publish({
				persist: { models: next, checkedAt: Date.now() },
				update: () => {
					models = next;
				},
			});
		},
	};
}
