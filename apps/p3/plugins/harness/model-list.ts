// The models the `subagent` tool names: each model's name for the agent (`modelNames`: the shortest of its model id,
// `<provider>/<model id>` and `<login>/<model id>` that names it alone; a login's provider id, `<provider>~<login>`,
// is no name an agent could guess), the `models` action's listing of the models with credentials (all, or those a
// query matches), and the close matches it suggests for a model it does not know.

import type { Api, Model } from "@earendil-works/p3/v1";
import { loginOfProvider } from "../providers/contract.ts";

/** What the names and the listing read of a model: its provider's id (a login's: `<provider>~<login>`), id and name. */
export type ListedModel = Pick<Model<Api>, "provider" | "id" | "name">;

/**
 * The models' names: the models each text names (`named`: any of their forms; one model, or several when the text is
 * ambiguous) and each model's name, by its reference (`provider/id`, as the roster records it).
 */
export type ModelNames = {
	readonly named: ReadonlyMap<string, readonly ListedModel[]>;
	readonly names: ReadonlyMap<string, string>;
};

/**
 * The names of the models `models` (the registry's): a model is named by its id alone when no other model has that id,
 * else by `<provider>/<id>` when no other login of its provider offers it, else by `<login>/<id>` (the login's thing
 * id; ERNDL-705 gives logins names later), else by its reference. Every form names it, unless another model has it too.
 */
export function modelNames(models: readonly ListedModel[]): ModelNames {
	const named = new Map<string, ListedModel[]>();
	const forms = models.map((model) => ({ model, forms: formsOf(model) }));
	for (const { model, forms: each } of forms) {
		for (const form of new Set(each)) {
			const list = named.get(form);
			if (list === undefined) named.set(form, [model]);
			else list.push(model);
		}
	}
	const names = new Map<string, string>();
	for (const { model, forms: each } of forms) {
		const ref = refOf(model);
		names.set(ref, each.find((form) => named.get(form)?.length === 1) ?? ref);
	}
	return { named, names };
}

/** What a text names: one model, several (the names of each), or none. */
export type Resolved =
	| { readonly kind: "one"; readonly model: ListedModel }
	| { readonly kind: "several"; readonly names: readonly string[] }
	| { readonly kind: "none" };

/** The model `text` names: by any of its forms (its name, or a longer one). */
export function resolveModel(names: ModelNames, text: string): Resolved {
	const named = names.named.get(text) ?? [];
	const [first] = named;
	if (first === undefined) return { kind: "none" };
	if (named.length === 1) return { kind: "one", model: first };
	return { kind: "several", names: named.map((model) => nameOf(names, model)) };
}

/** The name of the model the reference `ref` names (`provider/id`, as the roster records it); one gone: `ref`. */
export function modelName(names: ModelNames, ref: string): string {
	return names.names.get(ref) ?? ref;
}

/** The name of `model`. */
function nameOf(names: ModelNames, model: ListedModel): string {
	return modelName(names, refOf(model));
}

/** A model's forms, shortest first: its id, `<provider>/<id>`, `<login>/<id>` (a login's model), its reference. */
function formsOf(model: ListedModel): string[] {
	const login = loginOfProvider(model.provider);
	const ref = refOf(model);
	if (login === undefined) return [model.id, ref];
	return [model.id, `${login.provider}/${model.id}`, `${login.login}/${model.id}`, ref];
}

/** A model's reference: `provider/id`, its provider's id as the registry has it. */
function refOf(model: Pick<ListedModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** A model as the `models` action lists it: its name, the provider (and login) it comes from, its display name. */
type Listed = { model: string; provider: string; login?: string; name: string };

/** How many models the `models` action lists one by one, at most. */
const MAX_LISTED = 100;

/**
 * The `models` action's answer: the models matching `query` (words each starting a word of the model's provider,
 * login, id or name), each by its name (`names`, what spawn and configure take), provider, login and display name;
 * when more than `MAX_LISTED` match, the count per provider instead, so no provider is cut off.
 */
export function listModels(
	available: readonly ListedModel[],
	query: string | undefined,
	names: ModelNames,
): { models: Listed[] } | { count: number; providers: Record<string, number> } {
	const matching = query === undefined ? available : available.filter(matcher(query));
	if (matching.length <= MAX_LISTED) return { models: matching.map((model) => listed(model, names)) };
	const providers: Record<string, number> = {};
	for (const model of matching) {
		const provider = providerOf(model);
		providers[provider] = (providers[provider] ?? 0) + 1;
	}
	return { count: matching.length, providers };
}

/** `model` as the listing shows it. */
function listed(model: ListedModel, names: ModelNames): Listed {
	const login = loginOfProvider(model.provider);
	return {
		model: nameOf(names, model),
		provider: login?.provider ?? model.provider,
		...(login === undefined ? {} : { login: login.login }),
		name: model.name,
	};
}

/** The provider `model` comes from: a login's provider without the login. */
function providerOf(model: ListedModel): string {
	return loginOfProvider(model.provider)?.provider ?? model.provider;
}

/** How many close matches a refused model gets. */
const MAX_SUGGESTED = 5;

/**
 * The names of the available models whose provider, login, id or name have every word of `text` (a model nothing
 * resolved), those of its provider first: "faux/model-2" finds "faux-model-2".
 */
export function closeModels(available: readonly ListedModel[], text: string, names: ModelNames): string[] {
	const slash = text.indexOf("/");
	const provider = slash < 0 ? undefined : text.slice(0, slash);
	const matching = available.filter(matcher(text));
	const ordered = [
		...matching.filter((model) => providerOf(model) === provider),
		...matching.filter((model) => providerOf(model) !== provider),
	];
	return ordered.slice(0, MAX_SUGGESTED).map((model) => nameOf(names, model));
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
