import type { AssistantMessage, Message, UserMessage } from "@kennyfrc/mu-ai";
import { buildTodoContinuationReminder, getTodoSummary } from "./tools/todowrite.js";

function findTodoContinuationTarget(
	messages: Message[],
): { type: "append_to_last_user"; userIndex: number } | { type: "append_new_user" } | null {
	if (messages.length === 0) return null;

	let cursor = messages.length - 1;
	let trailingUserIndex: number | null = null;

	if (messages[cursor]?.role === "user") {
		trailingUserIndex = cursor;
		cursor -= 1;
	}

	let sawToolResult = false;
	while (cursor >= 0 && messages[cursor]?.role === "toolResult") {
		sawToolResult = true;
		cursor -= 1;
	}

	if (!sawToolResult) return null;

	const assistant = messages[cursor];
	if (!assistant || assistant.role !== "assistant") return null;
	if ((assistant as AssistantMessage).stopReason !== "toolUse") return null;

	if (trailingUserIndex !== null) {
		return { type: "append_to_last_user", userIndex: trailingUserIndex };
	}

	return { type: "append_new_user" };
}

export function createTodoReminderPreprocessor(
	base?: (messages: Message[], abortSignal?: AbortSignal) => Message[] | Promise<Message[]>,
): (messages: Message[], abortSignal?: AbortSignal) => Promise<Message[]> {
	return async (messages: Message[], abortSignal?: AbortSignal) => {
		const processed = base ? await base(messages, abortSignal) : messages;
		const reminder = buildTodoContinuationReminder(getTodoSummary());
		if (!reminder) {
			return processed;
		}

		const target = findTodoContinuationTarget(processed);
		if (!target) {
			return processed;
		}

		if (target.type === "append_to_last_user") {
			return processed.map((message, index) => {
				if (index !== target.userIndex || message.role !== "user" || !Array.isArray(message.content)) {
					return message;
				}
				return {
					...message,
					content: message.content.map((block: (typeof message.content)[number]) =>
						block.type === "text" ? { ...block, text: `${block.text}${reminder}` } : block,
					),
				};
			});
		}

		const hiddenUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: reminder }],
			timestamp: Date.now(),
		};
		return [...processed, hiddenUser];
	};
}
