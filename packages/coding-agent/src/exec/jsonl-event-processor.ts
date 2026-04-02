import type { AgentEvent } from "@kennyfrc/mu-agent-core";
import type { AssistantMessage, Message } from "@kennyfrc/mu-ai";

import type {
	ExecCommandExecutionItem,
	ExecEvent,
	ExecFileChangeItem,
	ExecItem,
	ExecTodoListEntry,
	ExecTodoListItem,
	ExecTodoListSummary,
	ExecToolCallItem,
} from "./exec-events.js";

type ProcessorOptions = {
	threadId: string;
};

type Processor = {
	consume(event: AgentEvent): ExecEvent[];
};

function assistantTextFromMessage(message: Message): string {
	if (message.role !== "assistant") {
		return "";
	}

	return message.content
		.filter((block): block is Extract<Message["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseApplyPatchPaths(input: string): string[] {
	const matches = input.matchAll(/^\*\*\* (?:Add File|Delete File|Update File):\s+(.+)$/gm);
	const paths = Array.from(matches, (match) => match[1]?.trim()).filter((path): path is string => Boolean(path));
	return [...new Set(paths)];
}

function deriveFileChangePaths(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (!args) return [];
	if (typeof args.path === "string") return [args.path];
	if (toolName === "apply_patch" && typeof args.input === "string") {
		return parseApplyPatchPaths(args.input);
	}
	return [];
}

function deriveTodoSummaryFromEntries(items: ExecTodoListEntry[]): ExecTodoListSummary {
	return {
		total: items.length,
		pending: items.filter((item) => item.status === "pending").length,
		in_progress: items.filter((item) => item.status === "in_progress").length,
		completed: items.filter((item) => item.status === "completed").length,
		blocked: items.filter((item) => item.status === "blocked").length,
	};
}

function normalizeTodoEntries(value: unknown): ExecTodoListEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.map((entry, index) => ({
			id: typeof entry.id === "string" ? entry.id : `todo_${index + 1}`,
			content: typeof entry.content === "string" ? entry.content : "",
			status: typeof entry.status === "string" ? entry.status : "pending",
			priority: typeof entry.priority === "string" ? entry.priority : "medium",
		}))
		.filter((entry) => entry.content.length > 0);
}

function normalizeTodoSummary(value: unknown, fallbackItems: ExecTodoListEntry[]): ExecTodoListSummary {
	if (!isRecord(value)) {
		return deriveTodoSummaryFromEntries(fallbackItems);
	}
	return {
		total: typeof value.total === "number" ? value.total : fallbackItems.length,
		pending:
			typeof value.pending === "number"
				? value.pending
				: fallbackItems.filter((item) => item.status === "pending").length,
		in_progress:
			typeof value.in_progress === "number"
				? value.in_progress
				: typeof value.inProgress === "number"
					? value.inProgress
					: fallbackItems.filter((item) => item.status === "in_progress").length,
		completed:
			typeof value.completed === "number"
				? value.completed
				: fallbackItems.filter((item) => item.status === "completed").length,
		blocked:
			typeof value.blocked === "number"
				? value.blocked
				: fallbackItems.filter((item) => item.status === "blocked").length,
	};
}

function extractExitCode(result: unknown): number | undefined {
	if (!isRecord(result)) return undefined;
	if (typeof result.exitCode === "number") return result.exitCode;
	if (isRecord(result.details) && typeof result.details.exitCode === "number") return result.details.exitCode;
	return undefined;
}

function buildToolStartItem(toolCallId: string, toolName: string, args: unknown): ExecItem {
	const argumentRecord = isRecord(args) ? args : undefined;
	const command = argumentRecord?.cmd;

	if ((toolName === "exec_command" || toolName === "bash") && typeof command === "string") {
		const item: ExecCommandExecutionItem = {
			id: toolCallId,
			type: "command_execution",
			command,
			status: "in_progress",
		};
		return item;
	}

	if (toolName === "apply_patch" || toolName === "write" || toolName === "edit") {
		const item: ExecFileChangeItem = {
			id: toolCallId,
			type: "file_change",
			paths: deriveFileChangePaths(toolName, argumentRecord),
			change_kind: toolName,
			status: "in_progress",
		};
		return item;
	}

	if (toolName === "todo_write") {
		const items = normalizeTodoEntries(argumentRecord?.todos);
		const item: ExecTodoListItem = {
			id: toolCallId,
			type: "todo_list",
			status: "in_progress",
			summary: deriveTodoSummaryFromEntries(items),
			items,
		};
		return item;
	}

	const item: ExecToolCallItem = {
		id: toolCallId,
		type: "tool_call",
		tool_name: toolName,
		status: "in_progress",
		arguments: argumentRecord,
	};
	return item;
}

function updateItemOutput(item: ExecItem, output: string): ExecItem {
	if (item.type === "command_execution") {
		return {
			...item,
			output: `${item.output ?? ""}${output}`,
		};
	}
	if (item.type === "tool_call") {
		return {
			...item,
			output: `${item.output ?? ""}${output}`,
		};
	}
	if (item.type === "todo_list") {
		return item;
	}
	if (item.type === "file_change") {
		return item;
	}
	return item;
}

function completeItem(item: ExecItem, result: unknown, isError: boolean): ExecItem {
	if (item.type === "command_execution") {
		return {
			...item,
			status: isError ? "failed" : "completed",
			exit_code: extractExitCode(result),
		};
	}
	if (item.type === "file_change") {
		return {
			...item,
			status: isError ? "failed" : "completed",
		};
	}
	if (item.type === "todo_list") {
		const resultRecord = isRecord(result) ? result : undefined;
		const details = resultRecord && isRecord(resultRecord.details) ? resultRecord.details : undefined;
		const items = normalizeTodoEntries(details?.todos ?? item.items);
		return {
			...item,
			status: isError ? "failed" : "completed",
			items,
			summary: normalizeTodoSummary(details?.summary, items),
		};
	}
	if (item.type === "tool_call") {
		return {
			...item,
			status: isError ? "failed" : "completed",
			result,
		};
	}
	return item;
}

export function createExecJsonEventProcessor(options: ProcessorOptions): Processor {
	let emittedThreadStarted = false;
	let publicTurnActive = false;
	let assistantMessageCounter = 0;
	const runningItems = new Map<string, ExecItem>();

	return {
		consume(event: AgentEvent): ExecEvent[] {
			const events: ExecEvent[] = [];

			if (event.type === "agent_start" && !emittedThreadStarted) {
				emittedThreadStarted = true;
				events.push({ type: "thread.started", thread_id: options.threadId });
				return events;
			}

			switch (event.type) {
				case "turn_start":
					if (!publicTurnActive) {
						publicTurnActive = true;
						events.push({ type: "turn.started" });
					}
					break;
				case "tool_execution_start": {
					const item = buildToolStartItem(event.toolCallId, event.toolName, event.args);
					runningItems.set(event.toolCallId, item);
					events.push({ type: "item.started", item });
					break;
				}
				case "tool_execution_progress": {
					const item = runningItems.get(event.toolCallId);
					if (!item) {
						break;
					}
					const updated = updateItemOutput(item, event.output);
					runningItems.set(event.toolCallId, updated);
					events.push({ type: "item.updated", item: updated });
					break;
				}
				case "tool_execution_end": {
					const item = runningItems.get(event.toolCallId);
					if (!item) {
						break;
					}
					const completed = completeItem(item, event.result, event.isError);
					runningItems.delete(event.toolCallId);
					events.push({ type: "item.completed", item: completed });
					break;
				}
				case "message_end": {
					const text = assistantTextFromMessage(event.message);
					if (!text) {
						break;
					}
					assistantMessageCounter += 1;
					events.push({
						type: "item.completed",
						item: {
							id: `assistant_${assistantMessageCounter}`,
							type: "agent_message",
							text,
						},
					});
					break;
				}
				case "turn_end": {
					const assistant = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
					const errorText = assistant?.errorMessage?.trim();
					const hasToolCalls = Boolean(assistant?.content.some((block) => block.type === "toolCall"));
					if (errorText || assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
						events.push({ type: "error", error: errorText || "Assistant turn failed" });
						events.push({ type: "turn.failed", error: errorText || "Assistant turn failed" });
						publicTurnActive = false;
					} else if (!hasToolCalls) {
						events.push({ type: "turn.completed" });
						publicTurnActive = false;
					} else {
						// Internal continuation turn boundary; keep the public exec turn open.
					}
					break;
				}
				default:
					break;
			}

			return events;
		},
	};
}
