// The models the `subagent` tool names: the `models` action's listing of the models with credentials (all, or those a
// query matches), and the close matches it suggests for a model it does not know.

import type { Api, Model } from "@earendil-works/p3/v1";

/** What the listing reads of a model. */
export type ListedModel = Pick<Model<Api>, "provider" | "id" | "name">;

/**
 * The `models` action's answer: the models matching `query` (words each starting a word of the model's provider, id or
 * name), each as `model` (`provider/id`, what spawn and configure take) and `name`; when more than `MAX_LISTED` match,
 * the count per provider instead, so no provider is cut off.
 */
export function listModels(
	available: readonly ListedModel[],
	query: string | undefined,
): { models: { model: string; name: string }[] } | { count: number; providers: Record<string, number> } {
	const matching = query === undefined ? available : available.filter(matcher(query));
	if (matching.length <= MAX_LISTED)
		return { models: matching.map((model) => ({ model: refOf(model), name: model.name })) };
	const providers: Record<string, number> = {};
	for (const { provider } of matching) providers[provider] = (providers[provider] ?? 0) + 1;
	return { count: matching.length, providers };
}

const MAX_LISTED = 100;

/**
 * The available models whose provider, id or name have every word of `text` (a model nothing resolved), those of its
 * provider first: "faux/model-2" finds "faux/faux-model-2".
 */
export function closeModels(available: readonly ListedModel[], text: string): string[] {
	const slash = text.indexOf("/");
	const provider = slash < 0 ? undefined : text.slice(0, slash);
	const matching = available.filter(matcher(text));
	const ordered = [
		...matching.filter((model) => model.provider === provider),
		...matching.filter((model) => model.provider !== provider),
	];
	return ordered.slice(0, MAX_SUGGESTED).map(refOf);
}

const MAX_SUGGESTED = 5;

/** A model's reference as the tool takes it: `provider/id`. */
export function refOf(model: Pick<ListedModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Whether a model matches `query`: each of its words starts a word of the model's reference or name. */
function matcher(query: string): (model: ListedModel) => boolean {
	const wanted = words(query);
	return (model) => {
		const own = words(`${refOf(model)} ${model.name}`);
		return wanted.every((word) => own.some((each) => each.startsWith(word)));
	};
}

/** The lower-case words of `text`: its runs of letters and digits. */
function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}
