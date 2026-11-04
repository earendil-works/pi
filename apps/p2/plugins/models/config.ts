// Shared by the server and worker facets: p2's resource observer (settings.json, models.json, auth.json).

import { envDefaultModel } from "@p2/app/v1/node";
import type { ModelChoice, ModelInfo } from "./contract.ts";
import { type ResourceOptions, type ResourceSnapshot, Resources } from "./resources.ts";

export async function openResources(
	directory: string,
	fake: boolean,
	options: Omit<ResourceOptions, "directory" | "fake"> = {},
): Promise<Resources> {
	const resources = new Resources({ directory, fake, ...options });
	await resources.start();
	return resources;
}

export type ModelSummary = {
	readonly models: ModelInfo[];
	readonly defaultModel: ModelChoice | null;
	readonly errors: string[];
};

/** Models of signed-in providers (and the fake provider in fake mode), the default, and resource errors. */
export function summarize(resources: Resources, fake: boolean): ModelSummary {
	const snapshot = resources.snapshot();
	const signedIn = new Set(snapshot.credentials.map((credential) => credential.providerId));
	if (fake) signedIn.add("faux");
	const models = snapshot.models.filter((model) => signedIn.has(model.provider));
	// settings.json's default, then the environment's (Pi Mobile's order), then the first signed-in model.
	const configured = snapshot.settings.defaultModel ?? envDefaultModel();
	const wanted = snapshot.settings.thinkingLevel ?? "high";
	// The settings' level, clamped to the model's levels; a default model that is not listed keeps the settings' level
	// (as Pi Mobile's create falls back to it) rather than becoming "off".
	const level = (thinkingLevels: readonly string[] | undefined): string =>
		!thinkingLevels?.length || thinkingLevels.includes(wanted) ? wanted : (thinkingLevels.at(-1) ?? wanted);
	const fallback = configured
		? snapshot.models.find((model) => model.provider === configured.provider && model.modelId === configured.modelId)
		: models[0];
	const defaultModel = configured
		? { ...configured, thinkingLevel: level(fallback?.thinkingLevels) }
		: fallback
			? { provider: fallback.provider, modelId: fallback.modelId, thinkingLevel: level(fallback.thinkingLevels) }
			: null;
	return { models, defaultModel, errors: snapshot.errors.map((error) => error.message) };
}

export type ResourceState = { readonly summary: ModelSummary; readonly snapshot: ResourceSnapshot };

/** The configuration's state now: what `ModelConfig` publishes after each change. */
export function resourceState(resources: Resources, fake: boolean): ResourceState {
	return { summary: summarize(resources, fake), snapshot: resources.snapshot() };
}
