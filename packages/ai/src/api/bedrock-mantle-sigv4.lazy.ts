import type { createMantleSigV4Fetch } from "./bedrock-mantle-sigv4.ts";

export interface MantleSigV4Module {
	createMantleSigV4Fetch: typeof createMantleSigV4Fetch;
}

let sigV4ModuleOverride: MantleSigV4Module | undefined;

/**
 * Overrides the dynamically imported Mantle SigV4 signer. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled.
 */
export function setBedrockMantleSigV4Module(module: MantleSigV4Module): void {
	sigV4ModuleOverride = module;
}

/**
 * Loads the SigV4 signer through a variable specifier so bundlers (browser
 * smoke, Bun compile) cannot follow it into Node-only AWS credential code.
 */
export async function loadMantleSigV4Module(): Promise<MantleSigV4Module> {
	if (sigV4ModuleOverride) return sigV4ModuleOverride;
	const specifier = "./bedrock-mantle-sigv4.ts";
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return (await import(runtimeSpecifier)) as MantleSigV4Module;
}
