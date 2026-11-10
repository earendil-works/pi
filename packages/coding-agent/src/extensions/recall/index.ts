// Built-in checkpoint recall, enabled with the other native session tools.
import { createRecallContextTool } from "../../core/compaction/context-recall.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";

/** Register read-only model-assisted recall without exposing the parent agent's tools to its helper. */
export function createRecallExtension(): ExtensionFactory {
	return (pi) => pi.registerTool(createRecallContextTool(() => pi.getSettings()));
}

export default createRecallExtension();
