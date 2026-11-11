// Native delegation controls return bounded results and references, never embedded child transcripts.
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { pathsEqual } from "../../utils/paths.ts";
import { serializeConversation } from "../compaction/utils.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { convertToLlm } from "../messages.ts";
import { DEFAULT_MAX_BYTES } from "../tools/truncate.ts";
import { type AgentDefinition, discoverAgentDefinitions } from "./definitions.ts";
import type { StartSubagentOptions, SubagentManager } from "./manager.ts";
import { SubagentIdSchema, type SubagentInfo, type SubagentResult } from "./state.ts";

const parameters = Type.Object({
	action: Type.Union([
		Type.Literal("roles"),
		Type.Literal("start"),
		Type.Literal("list"),
		Type.Literal("inspect"),
		Type.Literal("history"),
		Type.Literal("result"),
		Type.Literal("wait"),
		Type.Literal("message"),
		Type.Literal("resume"),
		Type.Literal("cancel"),
		Type.Literal("delete"),
	]),
	id: Type.Optional(SubagentIdSchema),
	agent: Type.Optional(Type.String({ description: "Configured role name for start; defaults to worker." })),
	task: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Task for start, steering text for message, or continuation instruction for resume.",
		}),
	),
	context: Type.Optional(Type.String({ description: "Explicit background supplied to a new child." })),
	contextMode: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("snapshot")], {
			description: "Fresh is default; snapshot quotes the parent's active conversation in the child's own history.",
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description: "Return an ID immediately; completion is delivered automatically. Otherwise wait for the result.",
		}),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "History character offset from a previous nextOffset." }),
	),
	skip: Type.Optional(Type.Integer({ minimum: 0, description: "Role/run list offset from a previous nextSkip." })),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Maximum roles or children per list page; byte caps may return fewer. Defaults to 50.",
		}),
	),
});

/** Require explicit project trust or one-time interactive approval before using a repository-controlled role. */
export async function approveAgentDefinition(role: AgentDefinition, ctx: ExtensionContext): Promise<void> {
	if (role.source !== "project") return;
	const inProject = role.filePath && pathsEqual(dirname(role.filePath), join(ctx.cwd, CONFIG_DIR_NAME, "agents"));
	if (inProject && ctx.isProjectTrusted()) return;
	if (
		!ctx.hasUI ||
		!(await ctx.ui.confirm(
			"Run project agent?",
			`Use repository-controlled role ${JSON.stringify(role.name)} from ${role.filePath}? Its prompt and configured local tools can affect the shared working tree.`,
		))
	) {
		throw new Error(
			`Project agent ${role.name} was not approved; trust the project or approve the role interactively`,
		);
	}
}

/** Launch a configured role with an explicit, optionally inherited context captured at submission time. */
export async function startConfiguredAgent(
	manager: SubagentManager,
	role: AgentDefinition,
	task: string,
	ctx: ExtensionContext,
	options: { context?: string; contextMode?: "fresh" | "snapshot"; delivery: "sync" | "async"; signal?: AbortSignal },
): Promise<SubagentInfo> {
	await approveAgentDefinition(role, ctx);
	let context: StartSubagentOptions["context"] = options.context;
	if (options.contextMode === "snapshot") {
		const messages = convertToLlm(
			ctx.sessionManager.buildSessionProjection().messages.filter((message) => message.role !== "system"),
		);
		const snapshot = serializeConversation(messages, Infinity);
		context = [
			{ type: "text", text: options.context ? `${snapshot}\n\nExplicit background:\n${options.context}` : snapshot },
		];
		for (const [index, message] of messages.entries()) {
			if ((message.role === "user" || message.role === "toolResult") && typeof message.content !== "string") {
				for (const content of message.content) {
					if (content.type === "image")
						context.push(
							{
								type: "text",
								text: `Original image from parent context message ${index + 1} (${message.role}):`,
							},
							content,
						);
				}
			}
		}
	}
	return manager.start(role, task, { context, delivery: options.delivery, signal: options.signal });
}

/** Expose native start/list/inspect/history/result/wait/message/resume/cancel/delete controls. */
export function createSubagentToolDefinition(
	getManager: (ctx: ExtensionContext) => SubagentManager,
	agentDir: string,
	observe: (id: string, ctx: ExtensionContext) => void,
): ToolDefinition<typeof parameters> {
	return {
		name: "subagent",
		label: "Sub-agent",
		description:
			"Delegate and control LOCAL sub-agents with separate resumable chat histories. Use roles to discover specialties; start defaults to worker, fresh context, and synchronous execution. async:true returns an ID immediately and automatically delivers a bounded completion result. list/inspect show state, history pages original child messages, result retrieves a finished response, wait waits, message steers, resume continues a saved child, cancel stops, delete removes a finished child's logs. Children share this working tree and use scoped local built-in tools, NOT parent extension tools or remote/guest adapters. Never use this to delegate remote-only work. Child transcripts are never embedded in main tool details.",
		promptSnippet:
			"Delegate local tasks to configured roles with independent histories; manage synchronous or asynchronous child runs.",
		promptGuidelines: [
			"Use subagent roles to discover configured specialties. Supply a self-contained task and relevant context; children do not inherit this conversation unless contextMode is snapshot.",
			"Coordinate file ownership when agents edit the same working tree. A launch acknowledgment is not completion; use returned status, automatic results, wait, or inspect.",
			"Follow nextSkip for more roles or runs, and nextOffset for more original child history. Retrieve missing evidence rather than copying complete transcripts into the main conversation.",
			"Native sub-agents cannot recursively delegate. Child usage is reported separately from the parent's own model usage.",
		],
		parameters,
		async execute(_callId, params, signal, onUpdate, ctx) {
			signal?.throwIfAborted();
			if (params.action === "roles") {
				const catalog = discoverAgentDefinitions(ctx.cwd, agentDir);
				if (catalog.errors.length) return output({ agents: [], errors: catalog.errors });
				return outputPage(
					catalog.agents.map(({ systemPrompt: _prompt, ...metadata }) => metadata),
					params.skip ?? 0,
					params.limit ?? 50,
				);
			}
			const manager = getManager(ctx);
			if (params.action === "list") return outputPage(manager.list(), params.skip ?? 0, params.limit ?? 50);
			if (params.action === "start") {
				if (!params.task?.trim()) throw new Error("subagent start requires task");
				const catalog = discoverAgentDefinitions(ctx.cwd, agentDir);
				const role = catalog.agents.find((role) => role.name === (params.agent ?? "worker"));
				if (!role)
					throw new Error(
						catalog.errors.length
							? `Invalid agent definitions; fix these files before starting a child:\n${catalog.errors.map((error) => `${error.path}: ${error.error}`).join("\n")}`
							: `Unknown agent role ${params.agent ?? "worker"}. Use subagent roles to inspect definitions.`,
					);
				const agent = await startConfiguredAgent(manager, role, params.task, ctx, {
					context: params.context,
					contextMode: params.contextMode,
					delivery: params.async ? "async" : "sync",
					signal,
				});
				return await submitted(manager, agent, params.async ?? false, ctx, signal, onUpdate, observe);
			}
			// Tool input is untrusted; the schema cannot express which actions require an ID or task.
			if (!params.id) throw new Error(`subagent ${params.action} requires id`);
			const id = params.id;
			if (params.action === "inspect") return output({ agent: manager.inspect(id), task: manager.task(id) });
			if (params.action === "history") return output(manager.history(id, params.offset, 8000));
			if (params.action === "result") return output(manager.result(id));
			if (params.action === "wait") return completed(await manager.wait(id, signal));
			if (params.action === "cancel") return output({ agent: await manager.cancel(id) });
			if (params.action === "delete") {
				manager.remove(id);
				return output({ deleted: id });
			}
			if (params.action === "message") {
				if (!params.task?.trim()) throw new Error("subagent message requires task");
				return output({ agent: await manager.message(id, params.task) });
			}
			await approveAgentDefinition(manager.definition(id), ctx);
			const agent = manager.resume(id, params.task ?? "Continue the previous task from its saved state.", {
				delivery: params.async ? "async" : "sync",
				signal,
			});
			return await submitted(manager, agent, params.async ?? false, ctx, signal, onUpdate, observe);
		},
	};
}

async function submitted(
	manager: SubagentManager,
	agent: SubagentInfo,
	async: boolean,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ToolDefinition<typeof parameters>["execute"]>[3],
	observe: (id: string, ctx: ExtensionContext) => void,
) {
	onUpdate?.(output({ agent }));
	if (async) {
		observe(agent.id, ctx);
		return output({ agent, notice: "Submitted; this is not a completion result." });
	}
	return completed(await manager.wait(agent.id, signal));
}
function completed(result: SubagentResult) {
	if (result.agent.status !== "completed")
		throw new Error(
			`Sub-agent ${result.agent.id}: ${result.agent.status}. ${result.agent.error ?? "No completed answer"}\n${result.text}\nRead its own history for details.`,
		);
	return output(result);
}
function output(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
}

function outputPage(agents: readonly object[], skip: number, limit: number) {
	const rows: string[] = [];
	// Reserve the small JSON header; count serialized rows once so truncation cannot skip unseen entries.
	let bytes = 128;
	let end = skip;
	const maximum = Math.min(agents.length, skip + limit);
	for (; end < maximum; end++) {
		const row = JSON.stringify(agents[end]);
		const size = Buffer.byteLength(row) + 1;
		if (bytes + size > DEFAULT_MAX_BYTES) {
			if (!rows.length)
				throw new Error(
					`List entry ${end} exceeds the display cap: ${row.slice(0, 512)}. Inspect that entry individually; continue the list with skip=${end + 1}.`,
				);
			break;
		}
		rows.push(row);
		bytes += size;
	}
	return {
		content: [
			{
				type: "text" as const,
				text: `{"total":${agents.length}${end < agents.length ? `,"nextSkip":${end}` : ""},"agents":[${rows.join(",")}]}`,
			},
		],
		details: {},
	};
}
