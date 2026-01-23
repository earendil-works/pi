import type { AgentTool } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { parseApplyPatchInput } from "./apply-patch/parse.js";
import { runApplyPatchBinary } from "./apply-patch/runner.js";

const applyPatchSchema = Type.Object({
	input: Type.String({ description: "The entire contents of the apply_patch command" }),
});

export const applyPatchTool: AgentTool<typeof applyPatchSchema> = {
	name: "ApplyPatch",
	label: "ApplyPatch",
	description: getToolDescription("ApplyPatch"),
	parameters: applyPatchSchema,
	execute: async (
		_toolCallId: string,
		{ input }: { input: string },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const parsed = parseApplyPatchInput(input);
		const result = await runApplyPatchBinary({
			patch: input,
			cwd: process.cwd(),
			signal,
		});

		if (result.exitCode !== 0 && result.exitCode !== null) {
			const combined = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
			const message = combined.length > 0 ? combined : `apply_patch failed with code ${result.exitCode}`;
			throw new Error(message);
		}

		const output = result.stdout;
		return {
			content: [{ type: "text", text: output.length > 0 ? output : "(no output)" }],
			details: { parsed },
		};
	},
};
