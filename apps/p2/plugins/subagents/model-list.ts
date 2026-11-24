// The subagent tool's model listing: every available model or a filtered part, and close matches for a mistyped one.

import type { Api, Model } from "@earendil-works/pi-ai";

/** What the listing reads of a model. */
export type ListedModel = Pick<Model<Api>, "provider" | "id" | "name">;

/**
 * The `models` action's text: the models matching `query` (a provider or parts of an id or name), one per line, or,
 * when more than `MAX_LISTED` match, each matching provider with its count, so no provider is cut off.
 */
export function listModels(available: readonly ListedModel[], query: string | undefined): string {
	const matching = query === undefined ? available : available.filter(matcher(query));
	if (matching.length === 0)
		return query === undefined ? "No models with configured credentials." : `No available model matches ${query}.`;
	if (matching.length <= MAX_LISTED) return matching.map((model) => `${refText(model)} (${model.name})`).join("\n");
	const counts = new Map<string, number>();
	for (const model of matching) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	return [
		`${matching.length} models${query === undefined ? "" : ` match ${query}`}, too many to list. By provider:`,
		...[...counts].map(([provider, count]) => `${provider}: ${count}`),
		"List them with action models and model set to a provider or parts of a model id, e.g. 'anthropic' or 'sonnet 4'.",
	].join("\n");
}

const MAX_LISTED = 100;

/**
 * Available models whose provider, id or name contain every word of `text` (a model reference nothing resolved),
 * those of its provider first: "anthropic/fable-5.2" finds "anthropic/claude-fable-5-2".
 */
export function closeModels(available: readonly ListedModel[], text: string): string[] {
	const provider = text.includes("/") ? text.slice(0, text.indexOf("/")) : undefined;
	const matching = available.filter(matcher(text));
	return [
		...matching.filter((model) => model.provider === provider),
		...matching.filter((model) => model.provider !== provider),
	]
		.slice(0, MAX_SUGGESTED)
		.map(refText);
}

const MAX_SUGGESTED = 5;

// Each query word must start a word of the model's provider, id or name: "5 2" matches "fable-5-2" but not "fable-5-1".
function matcher(query: string): (model: ListedModel) => boolean {
	const wanted = words(query);
	return (model) => {
		const own = words(`${refText(model)} ${model.name}`);
		return wanted.every((word) => own.some((each) => each.startsWith(word)));
	};
}

const words = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

const refText = (model: ListedModel): string => `${model.provider}/${model.id}`;
