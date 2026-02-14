import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { bashTool } from "./bash.js";

function bashQuote(value: string): string {
	// Safest minimal quoting for bash: wrap in single quotes and escape any embedded single quotes.
	// abc'def -> 'abc'"'"'def'
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const execCommandSchema = Type.Object({
	cmd: Type.String({ description: "Shell command to execute." }),
	workdir: Type.Optional(Type.String({ description: "Working directory to run the command in." })),
	shell: Type.Optional(Type.String({ description: "Shell binary name/path (best-effort; may be ignored)." })),
	login: Type.Optional(
		Type.Boolean({ description: "Whether to run shell as a login shell (best-effort; may be ignored)." }),
	),
	tty: Type.Optional(Type.Boolean({ description: "Whether to allocate a TTY (best-effort; may be ignored)." })),
	yield_time_ms: Type.Optional(
		Type.Number({ description: "Streaming yield time in ms (best-effort; may be ignored)." }),
	),
	max_output_tokens: Type.Optional(
		Type.Number({ description: "Maximum output tokens to return (best-effort; may be ignored)." }),
	),
	sandbox_permissions: Type.Optional(Type.String({ description: "Sandbox permission request (ignored in mu)." })),
	justification: Type.Optional(
		Type.String({ description: "Justification for elevated permissions (ignored in mu)." }),
	),
	prefix_rule: Type.Optional(
		Type.Array(Type.String(), { description: "Suggested allowed command prefix rule (ignored in mu)." }),
	),
});

export const execCommandTool: AgentTool<typeof execCommandSchema, undefined> = {
	name: "exec_command",
	label: "exec_command",
	description: getToolDescription("exec_command"),
	parameters: execCommandSchema,
	execute: async (
		toolCallId: string,
		{
			cmd,
			workdir,
		}: {
			cmd: string;
			workdir?: string;
		},
		signal?: AbortSignal,
		onProgress?: (chunk: string) => void,
	) => {
		const command = workdir?.trim() ? `cd ${bashQuote(workdir)} && ${cmd}` : cmd;
		return bashTool.execute(toolCallId, { command }, signal, onProgress);
	},
};
