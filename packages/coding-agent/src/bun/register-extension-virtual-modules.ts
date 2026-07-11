/**
 * Register extension virtual modules for the Bun compiled binary.
 * Imported only from bun/cli.ts so the Node.js CLI never pays for these imports.
 */
import { registerExtensionVirtualModules } from "../core/extensions/loader.ts";
import { EXTENSION_VIRTUAL_MODULES } from "../core/extensions/virtual-modules.ts";

registerExtensionVirtualModules(EXTENSION_VIRTUAL_MODULES);
