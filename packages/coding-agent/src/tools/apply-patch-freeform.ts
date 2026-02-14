import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { type ApplyPatchToolDetails, applyPatchTool } from "./apply-patch.js";

const applyPatchSchema = Type.Object({
	input: Type.String({ description: "The entire contents of the apply_patch command" }),
});

export const applyPatchFreeformTool: AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> = {
	name: "apply_patch",
	label: "apply_patch",
	description: getToolDescription("apply_patch"),
	parameters: applyPatchSchema,
	execute: async (
		toolCallId: string,
		{ input }: { input: string },
		signal?: AbortSignal,
		onProgress?: (chunk: string) => void,
	) => {
		return applyPatchTool.execute(toolCallId, { input }, signal, onProgress);
	},
};
