import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		}),
	);
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false }));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
