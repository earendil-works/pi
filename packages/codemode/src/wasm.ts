// The djs module code mode runs on, with the dumper: the one place in pi-codemode that loads it.
import { loadModule } from "@earendil-works/djs";

/**
 * A compiled djs module, a `WebAssembly.Module`. Typed opaquely because the Node type definitions do not declare the
 * WebAssembly globals (they live in the DOM lib).
 */
export type CodemodeWasmModule = object;

/** The package file of the module, for hosts that resolve, embed, or copy it (Bun binaries, bundles). */
export const DJS_WASM_FILE = "@earendil-works/djs/wasm/djs.wasm";

/**
 * Reads and compiles the djs module once per location (a path or URL; default: `$DJS_WASM`, else the file in the
 * installed `@earendil-works/djs` package). A failed load is retried on the next call.
 */
export function loadDjsWasm(location?: string | URL): Promise<CodemodeWasmModule> {
	return location === undefined ? loadModule() : loadModule(location);
}
