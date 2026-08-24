import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the Bedrock Mantle Anthropic Messages implementation through a variable
 * specifier so browser bundlers cannot follow the import into Node-only AWS token modules.
 * The `.ts`/`.js` rewrite keeps the trick working from both source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockMantleAnthropicMessagesModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported Bedrock Mantle Anthropic Messages implementation.
 * Used by the Bun binary build, where the variable-specifier import cannot be bundled;
 * the build registers a statically imported module instead.
 */
export function setBedrockMantleAnthropicMessagesProviderModule(module: ProviderStreams): void {
	bedrockMantleAnthropicMessagesModuleOverride = module;
}

export const bedrockMantleAnthropicMessagesApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockMantleAnthropicMessagesModuleOverride ??
			((await importNodeOnlyApi("./bedrock-mantle-anthropic-messages.ts")) as ProviderStreams),
	);
