import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";

const bashSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export function createBashTool(executor: Executor): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Optionally provide a timeout in seconds.",
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { label: string; command: string; timeout?: number },
			signal?: AbortSignal,
			_onProgress?: (chunk: string) => void,
		) => {
			const result = await executor.exec(command, { timeout, signal });
			let output = "";
			if (result.stdout) output += result.stdout;
			if (result.stderr) {
				if (output) output += "\n";
				output += result.stderr;
			}

			if (result.code !== 0) {
				throw new Error(`${output}\n\nCommand exited with code ${result.code}`.trim());
			}

			return { content: [{ type: "text", text: output || "(no output)" }], details: undefined };
		},
	};
}
