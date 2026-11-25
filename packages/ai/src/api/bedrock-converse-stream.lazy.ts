import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the bedrock implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * AWS SDK. The `.ts`/`.js` rewrite keeps the trick working from both source
 * and built output. The specifier is resolved against this module's URL, not
 * left relative: a bundler inlining this file (Chord's worker base) keeps the
 * variable import, which would otherwise resolve against the bundle's location.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(new URL(runtimeSpecifier, import.meta.url).href);
};

let bedrockModuleLoader: (() => Promise<ProviderStreams>) | undefined;

/**
 * Overrides the dynamically imported bedrock implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the
 * build registers a statically imported module instead.
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleLoader = async () => module;
}

/**
 * Overrides how the bedrock implementation is imported, loaded on the first
 * bedrock request. Used by Node bundles that split at dynamic imports (see
 * `@earendil-works/pi-ai/lazy-bedrock-provider`): the loader's literal
 * `import()` lets the bundler keep the implementation in a lazy chunk.
 */
export function setBedrockProviderLoader(load: () => Promise<ProviderStreams>): void {
	bedrockModuleLoader = load;
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(async () =>
		bedrockModuleLoader
			? await bedrockModuleLoader()
			: ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
