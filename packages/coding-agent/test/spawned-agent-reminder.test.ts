import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	getModel,
	type Message,
	type ToolResultMessage,
	type UserMessage,
} from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { createSpawnedAgentsReminderPreprocessor } from "../src/spawned-agents.js";
import { stripSystemReminderTagsForDisplay } from "../src/utils/system-reminder.js";

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function buildAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason,
		timestamp: Date.now(),
	};
}

function buildToolResultMessage(toolName: string, details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-${Math.random()}`,
		toolName,
		content: [{ type: "text", text: toolName }],
		details,
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

describe("spawned agent reminder preprocessor", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawned-agent-reminder-"));
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		process.env.MU_CODING_AGENT_DIR = configDir;
	});

	afterEach(() => {
		if (previousConfigDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousConfigDir;
		}
		rmSync(configDir, { recursive: true, force: true });
	});

	test("injects a hidden reminder for completed unwaited spawned agents while preserving base preprocessing", async () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		const child = new SessionManager(false, undefined, false, workspacePath);
		child.startSession({ model, thinkingLevel: "off" } as never);
		child.saveMessage(buildAssistantMessage("CHILD_READY"));

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", {
				sessionId: child.getSessionId(),
				sessionFile: child.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);

		const preprocessor = createSpawnedAgentsReminderPreprocessor(parent, async (messages) => {
			return messages.map((message, index) => {
				if (index !== messages.length - 1 || message.role !== "user") return message;
				if (!Array.isArray(message.content)) return message;
				return {
					...message,
					content: message.content.map((block: (typeof message.content)[number]) =>
						block.type === "text" ? { ...block, text: `${block.text}\n\nBASE_PREPROCESSOR` } : block,
					),
				};
			});
		});

		const input: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		};

		const processed = await preprocessor([input]);
		const text = getLastUserText(processed);
		expect(text).toContain("BASE_PREPROCESSOR");
		expect(text).toContain("<system_reminder");
		expect(text).toContain("wait_agent");
		expect(text).toContain(child.getSessionId());
		expect(stripSystemReminderTagsForDisplay(text)).toContain("BASE_PREPROCESSOR");
		expect(stripSystemReminderTagsForDisplay(text)).not.toContain("system_reminder");
	});

	test("does not inject a reminder after the spawned child has already been waited on", async () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		const child = new SessionManager(false, undefined, false, workspacePath);
		child.startSession({ model, thinkingLevel: "off" } as never);
		child.saveMessage(buildAssistantMessage("CHILD_DONE"));

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", {
				sessionId: child.getSessionId(),
				sessionFile: child.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);
		parent.saveMessage(
			buildToolResultMessage("wait_agent", {
				results: [
					{
						sessionId: child.getSessionId(),
						status: "completed",
						stopReason: "stop",
						text: "CHILD_DONE",
					},
				],
			}),
		);

		const preprocessor = createSpawnedAgentsReminderPreprocessor(parent);
		const input: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		};

		const processed = await preprocessor([input]);
		expect(getLastUserText(processed)).not.toContain("<system_reminder");
	});

	test("fails closed when the parent session file is missing", async () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);
		parent.setSessionFile(join(configDir, "missing-parent-session.jsonl"));

		const preprocessor = createSpawnedAgentsReminderPreprocessor(parent);
		const input: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		};

		await expect(preprocessor([input])).resolves.toEqual([input]);
	});
});
