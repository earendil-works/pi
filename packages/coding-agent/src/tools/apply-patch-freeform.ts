import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { type ApplyPatchToolDetails, applyPatchTool } from "./apply-patch.js";

const applyPatchFreeformSchema = Type.String({
	description:
		"The entire contents of the apply_patch command (*** Begin Patch ... *** End Patch). This tool takes a freeform string argument, not a JSON object.",
});

export const applyPatchFreeformTool: AgentTool<typeof applyPatchFreeformSchema, ApplyPatchToolDetails> = {
	name: "apply_patch",
	label: "apply_patch",
	description: getToolDescription("apply_patch"),
	parameters: applyPatchFreeformSchema,
	execute: async (toolCallId: string, patch: string, signal?: AbortSignal, onProgress?: (chunk: string) => void) => {
		return applyPatchTool.execute(toolCallId, { input: patch }, signal, onProgress);
	},
};
