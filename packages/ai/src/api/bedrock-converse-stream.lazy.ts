import {
	stripRequestCacheBreakpoints,
	trustRequestCacheBreakpointAdapter,
} from "../request-cache-breakpoint-dispatch.ts";
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * Loads the bedrock implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * AWS SDK. The `.ts`/`.js` rewrite keeps the trick working from both source
 * and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported bedrock implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the
 * build registers a statically imported module instead.
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	const stream = module.stream;
	const streamSimple = module.streamSimple;
	bedrockModuleOverride = {
		stream: (model, context, options) => stream(model, stripRequestCacheBreakpoints(context), options),
		streamSimple: (model, context, options) => streamSimple(model, stripRequestCacheBreakpoints(context), options),
	};
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	trustRequestCacheBreakpointAdapter(
		lazyApi(
			async () =>
				bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
		),
	);
