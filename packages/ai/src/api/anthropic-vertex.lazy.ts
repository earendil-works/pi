import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the Anthropic Vertex implementation through a variable specifier so
 * bundlers (browser smoke, Bun compile) cannot follow the import into the
 * Node-only Google auth dependency tree. The `.ts`/`.js` rewrite keeps the
 * trick working from both source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let anthropicVertexModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported Anthropic Vertex implementation. Used by
 * the Bun binary build, where the variable-specifier import cannot be bundled;
 * the build registers a statically imported module instead.
 */
export function setAnthropicVertexProviderModule(module: ProviderStreams): void {
	anthropicVertexModuleOverride = module;
}

export const anthropicVertexApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			anthropicVertexModuleOverride ?? ((await importNodeOnlyApi("./anthropic-vertex.ts")) as ProviderStreams),
	);
