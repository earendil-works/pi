import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@kennyfrc/mu-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { createTodoReminderPreprocessor } from "../src/todo-reminder.js";
import { resetTodosForTest, todowriteTool } from "../src/tools/todowrite.js";
import { stripSystemReminderTagsForDisplay } from "../src/utils/system-reminder.js";

function buildAssistantToolUseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc_echo_1", name: "echo", arguments: { text: "hi" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.1-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function buildToolResultMessage(toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function getLastUserText(messages: Message[]): string {
	const last = messages.at(-1);
	if (!last || last.role !== "user") {
		throw new Error("Expected final message to be user");
	}
	if (!Array.isArray(last.content)) {
		return last.content;
	}
	return last.content
		.filter((block: (typeof last.content)[number]): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("todo reminder preprocessor", () => {
	beforeEach(() => {
		resetTodosForTest();
	});

	it("injects a hidden reminder as a synthetic trailing user message after tool results when active todos remain", async () => {
		await todowriteTool.execute("call-1", {
			todos: [
				{ content: "In progress", status: "in_progress", priority: "high" },
				{ content: "Pending", status: "pending", priority: "medium" },
			],
		});

		const preprocessor = createTodoReminderPreprocessor();
		const messages: Message[] = [buildAssistantToolUseMessage(), buildToolResultMessage("echo", "echo:hi")];

		const processed = await preprocessor(messages);
		expect(processed).toHaveLength(3);
		const reminderText = getLastUserText(processed);
		expect(reminderText).toContain("<system_reminder");
		expect(reminderText).toContain('pending="1"');
		expect(reminderText).toContain('in_progress="1"');
		expect(stripSystemReminderTagsForDisplay(reminderText)).toBe("");
	});

	it("appends the hidden reminder to an already-injected trailing user message", async () => {
		await todowriteTool.execute("call-1", {
			todos: [{ content: "Pending", status: "pending", priority: "medium" }],
		});

		const preprocessor = createTodoReminderPreprocessor();
		const injectedUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "STEER: do something else" }],
			timestamp: Date.now(),
		};
		const messages: Message[] = [
			buildAssistantToolUseMessage(),
			buildToolResultMessage("echo", "echo:hi"),
			injectedUser,
		];

		const processed = await preprocessor(messages);
		expect(processed).toHaveLength(3);
		const lastUserText = getLastUserText(processed);
		expect(lastUserText).toContain("STEER: do something else");
		expect(lastUserText).toContain("<system_reminder");
	});

	it("does not inject a reminder when there are no active todos", async () => {
		await todowriteTool.execute("call-1", {
			todos: [{ content: "Done", status: "completed", priority: "low" }],
		});

		const preprocessor = createTodoReminderPreprocessor();
		const messages: Message[] = [buildAssistantToolUseMessage(), buildToolResultMessage("echo", "echo:hi")];

		await expect(preprocessor(messages)).resolves.toEqual(messages);
	});

	it("preserves base preprocessor changes while adding the todo reminder", async () => {
		await todowriteTool.execute("call-1", {
			todos: [{ content: "Pending", status: "pending", priority: "medium" }],
		});

		const preprocessor = createTodoReminderPreprocessor(async (messages) => {
			return messages.map((message, index) => {
				if (index !== messages.length - 1 || message.role !== "user" || !Array.isArray(message.content)) {
					return message;
				}
				return {
					...message,
					content: message.content.map((block: (typeof message.content)[number]) =>
						block.type === "text" ? { ...block, text: `${block.text}\n\nBASE_PREPROCESSOR` } : block,
					),
				};
			});
		});

		const injectedUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "STEER: do something else" }],
			timestamp: Date.now(),
		};
		const messages: Message[] = [
			buildAssistantToolUseMessage(),
			buildToolResultMessage("echo", "echo:hi"),
			injectedUser,
		];

		const processed = await preprocessor(messages);
		const lastUserText = getLastUserText(processed);
		expect(lastUserText).toContain("BASE_PREPROCESSOR");
		expect(lastUserText).toContain("<system_reminder");
	});
});
