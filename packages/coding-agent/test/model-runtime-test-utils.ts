import type { CredentialStore } from "@tculpepp/spi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

/**
 * Load optional models.json configuration without introducing file-backed catalog locks into unit tests.
 *
 * secureMode is off here so these helpers exercise upstream provider behaviour.
 * The closed-network policy has its own coverage in secure-mode.test.ts.
 */
export async function createModelRegistry(
	credentials: CredentialStore,
	modelsPath?: string,
	secureMode = false,
): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			secureMode,
		}),
	);
}

export async function createInMemoryModelRegistry(
	credentials: CredentialStore,
	secureMode = false,
): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, secureMode }));
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
