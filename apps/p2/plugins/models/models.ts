import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createFakeModels } from "./fake.ts";

/** A host's models: the built-in providers, or in fake mode (demos, tests, docs) the scripted faux provider (fake.ts). */
export function createP2Models(fake: boolean, options: CreateModelsOptions = {}) {
	return fake ? createFakeModels(options) : builtinModels(options);
}
