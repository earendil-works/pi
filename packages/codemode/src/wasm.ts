// The djs module code mode runs on: the one place in pi-codemode that loads it.
import { loadModule } from "@earendil-works/djs";

/**
 * A compiled djs module, a `WebAssembly.Module`. Typed opaquely because the Node type definitions do not declare the
 * WebAssembly globals (they live in the DOM lib).
 */
export type CodemodeWasmModule = object;

/**
 * Reads and compiles the module once per location (a path or URL; default: the file in the installed
 * `@earendil-works/djs` package). A failed load is retried on the next call.
 */
export function loadCodemodeWasm(location?: string | URL): Promise<CodemodeWasmModule> {
	return loadModule(location);
}
