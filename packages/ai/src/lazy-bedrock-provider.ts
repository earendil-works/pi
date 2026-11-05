import { setBedrockProviderLoader } from "./api/bedrock-converse-stream.lazy.ts";

/**
 * Registers a bedrock loader with a literal dynamic import, for Node bundles
 * that split at dynamic imports (esbuild `splitting`, Chord's worker base):
 * the implementation and the AWS SDK land in a chunk loaded on the first
 * bedrock request, inside the bundle. Without it, pi-ai imports bedrock
 * through a variable specifier that bundlers cannot follow, so a bundle loads
 * it from pi-ai's own files. Browser bundles must not import this module.
 */
export function registerLazyBedrockProvider(): void {
	setBedrockProviderLoader(() => import("./api/bedrock-converse-stream.ts"));
}
