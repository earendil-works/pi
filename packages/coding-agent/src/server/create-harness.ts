import {
	AgentHarness,
	type AgentHarnessOptions,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionEnv,
	type ExecutionToolContext,
	type HarnessTool,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { buildSystemPrompt } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";

const HARNESS_TOOL_SYSTEM_PROMPT_CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
} as const;

function bindExecutionTool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
): HarnessTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as Static<TParameters>, signal, onUpdate, context),
	};
}

export interface CreateCodingAgentHarnessOptions
	extends Omit<AgentHarnessOptions, "activeToolNames" | "systemPrompt" | "toolContext" | "tools"> {
	env: ExecutionEnv;
	bashCommandPrefix?: string;
}

export function buildCodingAgentHarnessSystemPrompt(cwd: string): string {
	const toolSnippets = Object.fromEntries(
		Object.entries(HARNESS_TOOL_SYSTEM_PROMPT_CONTRIBUTIONS).map(([name, contribution]) => [
			name,
			contribution.snippet,
		]),
	);
	const promptGuidelines = [
		...HARNESS_TOOL_SYSTEM_PROMPT_CONTRIBUTIONS.bash.guidelines,
		...Object.entries(HARNESS_TOOL_SYSTEM_PROMPT_CONTRIBUTIONS).flatMap(([name, contribution]) =>
			name === "bash" ? [] : contribution.guidelines,
		),
	];
	return buildSystemPrompt({
		cwd,
		selectedTools: Object.keys(HARNESS_TOOL_SYSTEM_PROMPT_CONTRIBUTIONS),
		toolSnippets,
		promptGuidelines,
		contextFiles: [],
		skills: [],
	});
}

export async function createCodingAgentHarness(options: CreateCodingAgentHarnessOptions) {
	const { env, bashCommandPrefix, ...harnessOptions } = options;
	const metadata = await options.session.getMetadata();
	const toolContext = { env } satisfies ExecutionToolContext;
	const tools: HarnessTool[] = [
		bindExecutionTool(createReadTool<ExecutionToolContext>(), toolContext),
		bindExecutionTool(
			createBashTool<ExecutionToolContext>({
				commandPrefix: bashCommandPrefix,
				prepare: (execution) => {
					execution.env.PI_SESSION_ID = metadata.id;
					execution.env.PI_PROVIDER = options.model.provider;
					execution.env.PI_MODEL = options.model.id;
					execution.env.PI_REASONING_LEVEL = options.thinkingLevel ?? "off";
				},
			}),
			toolContext,
		),
		bindExecutionTool(createEditTool<ExecutionToolContext>(), toolContext),
		bindExecutionTool(createWriteTool<ExecutionToolContext>(), toolContext),
	];
	return AgentHarness.create({
		...harnessOptions,
		tools,
		activeToolNames: tools.map((tool) => tool.name),
		systemPrompt: () => buildCodingAgentHarnessSystemPrompt(env.cwd),
	});
}
