import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the Bedrock Mantle implementation through a variable specifier so browser
 * bundlers cannot follow the import into Node-only AWS credential/signing modules.
 * The `.ts`/`.js` rewrite keeps the trick working from both source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockMantleOpenAIResponsesModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported Bedrock Mantle implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the build
 * registers a statically imported module instead.
 */
export function setBedrockMantleOpenAIResponsesProviderModule(module: ProviderStreams): void {
	bedrockMantleOpenAIResponsesModuleOverride = module;
}

export const bedrockMantleOpenAIResponsesApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockMantleOpenAIResponsesModuleOverride ??
			((await importNodeOnlyApi("./bedrock-mantle-openai-responses.ts")) as ProviderStreams),
	);
