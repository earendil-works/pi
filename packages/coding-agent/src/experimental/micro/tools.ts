import type {
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	ExecutionEnv,
	ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import type { JsonValue, ToolDeclaration, ToolResult } from "@earendil-works/pi-agent-core/experimental/pico3";
import type { Static, TSchema } from "typebox";
import type { ModelToolMetadata } from "./models.ts";

export interface MicroTools {
	declarations: ToolDeclaration[];
	modelMetadata: ReadonlyMap<string, ModelToolMetadata>;
}

/** Adapt the same execution tools mini uses to Pico's smaller tool contract. */
export function createMicroTools(env: ExecutionEnv): MicroTools {
	const read = createReadTool<ExecutionToolContext>();
	const bash = createBashTool<ExecutionToolContext>();
	const edit = createEditTool<ExecutionToolContext>();
	const write = createWriteTool<ExecutionToolContext>();
	const source = [read, bash, edit, write];
	return {
		declarations: [
			adaptTool(read, env, "safe", { maxBytes: 128 * 1024, maxLines: 2500, retain: "head" }),
			adaptTool(bash, env, "unsafe", { maxBytes: 128 * 1024, maxLines: 2500, retain: "tail" }),
			adaptTool(edit, env, "unsafe", { maxBytes: 128 * 1024, maxLines: 2500, retain: "head" }),
			adaptTool(write, env, "unsafe", { maxBytes: 128 * 1024, maxLines: 2500, retain: "head" }),
		],
		modelMetadata: new Map(source.map((tool) => [tool.name, { constrainedSampling: tool.constrainedSampling }])),
	};
}

function adaptTool<P extends TSchema, Details>(
	tool: AgentHarnessTool<ExecutionToolContext, P, Details>,
	env: ExecutionEnv,
	replay: "safe" | "unsafe",
	output: NonNullable<ToolDeclaration["output"]>,
): ToolDeclaration<P> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		replay,
		output,
		async execute(args: Static<P>, api, ctx): Promise<ToolResult> {
			let updates = Promise.resolve();
			let updateError: unknown;
			let latestProgress:
				| { content: Awaited<ReturnType<typeof tool.execute>>["content"]; details: Details }
				| undefined;
			let lastProgressAt = 0;
			const flushProgress = (): void => {
				const partial = latestProgress;
				if (!partial) return;
				latestProgress = undefined;
				lastProgressAt = Date.now();
				const progress = partial.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				const details = jsonValue(partial.details);
				updates = updates
					.then(() =>
						api.progress((slot) => {
							if (progress) slot.progress = progress;
							if (details !== undefined) slot.details = details;
						}, ctx),
					)
					.catch((error: unknown) => {
						updateError ??= error;
					});
			};
			const invocation: AgentHarnessToolInvocation = {
				invocationId: api.callId,
				operationId: String(api.taskId),
				turnId: String(api.conversationId),
				getMemo: (name) => api.memo(name, ctx),
				setMemo: async (name, value) => {
					if (value !== undefined) await api.memo(name, value, ctx);
				},
			};
			try {
				const preparedArgs = tool.prepareArguments?.(args) ?? args;
				const result = await tool.execute(
					api.callId,
					preparedArgs,
					(partial, options) => {
						latestProgress = partial;
						if (options?.checkpoint || Date.now() - lastProgressAt >= 100) flushProgress();
					},
					{ env },
					invocation,
					ctx,
				);
				flushProgress();
				await updates;
				if (updateError !== undefined) throw updateError;
				return {
					content: result.content,
					...(result.details === undefined ? {} : { details: jsonValue(result.details) }),
					...(result.terminate ? { control: { terminate: true } } : {}),
				};
			} catch (error) {
				if (ctx.abortSignal?.aborted) throw error;
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}
		},
	};
}

function jsonValue(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
