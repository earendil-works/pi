// The model settings things' overrides as a session gets them (decision 118b), as pure steps: indexed by model id,
// nearest thing first (`overridesOf`), and applied to a login's models (`applied`): each field from the nearest
// override that sets it, a hidden model left out. An override names its model's provider type, or none (every type's
// model of that id).

import type { Api, Model } from "@earendil-works/p3/v1";
import type { ModelOverride } from "./contract.ts";

/** The overrides that reach a session, by model id, each list nearest first. */
export type Overrides = ReadonlyMap<string, readonly ModelOverride[]>;

/** No overrides. */
export const NO_OVERRIDES: Overrides = new Map();

/**
 * The overrides of model settings things `settings`, nearest first, by model id; a model's list is `previous`'s while
 * it has the same overrides, so what did not change for a model keeps its identity.
 */
export function overridesOf(settings: readonly (readonly ModelOverride[])[], previous: Overrides): Overrides {
	const made = new Map<string, ModelOverride[]>();
	for (const overrides of settings) {
		for (const override of overrides) {
			const list = made.get(override.model);
			if (list === undefined) made.set(override.model, [override]);
			else list.push(override);
		}
	}
	if (made.size === 0) return NO_OVERRIDES;
	const byModel = new Map<string, readonly ModelOverride[]>(made);
	for (const [model, list] of made) {
		const old = previous.get(model);
		if (old !== undefined && old.length === list.length && old.every((one, i) => one === list[i]))
			byModel.set(model, old);
	}
	return byModel;
}

/**
 * The models `models` of provider type `provider` with `overrides` applied: each field the nearest override of the
 * model sets; a model the nearest override that says so hides is left out. `models` itself when no override names
 * one of them.
 */
export function applied(provider: string, models: Model<Api>[], overrides: Overrides): Model<Api>[] {
	if (overrides.size === 0) return models;
	let changed = false;
	const result: Model<Api>[] = [];
	for (const model of models) {
		const mine = overrides
			.get(model.id)
			?.filter((override) => override.provider === undefined || override.provider === provider);
		if (mine === undefined || mine.length === 0) {
			result.push(model);
			continue;
		}
		changed = true;
		// Each field from the nearest override that sets it: laid on from the farthest (a field an override leaves out
		// is absent in it, its schema's `opt`). The fields left are the model's own, by pi-ai's names.
		const set: ModelOverride = Object.assign({}, ...mine.toReversed());
		const { provider: _provider, model: _model, hidden, maxRequestBytes, ...fields } = set;
		if (hidden === true) continue;
		const inputLimits = maxRequestBytes === undefined ? undefined : { ...model.inputLimits, maxRequestBytes };
		result.push({ ...model, ...fields, ...(inputLimits === undefined ? {} : { inputLimits }) });
	}
	return changed ? result : models;
}
