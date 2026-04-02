import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AskUserResult } from "../ask-user/types.js";
import type { ExtensionApi } from "../types.js";
import askUserExtension from "./ask-user.js";

const { promptAskUserMock } = vi.hoisted(() => ({
	promptAskUserMock: vi.fn<(request: unknown) => Promise<AskUserResult>>(),
}));

vi.mock("../ask-user/interaction.js", async () => {
	const actual = await vi.importActual<typeof import("../ask-user/interaction.js")>("../ask-user/interaction.js");
	return {
		...actual,
		promptAskUser: promptAskUserMock,
	};
});

describe("ask-user preset extension", () => {
	const tempDirs: string[] = [];
	const originalCwd = process.cwd();

	beforeEach(() => {
		promptAskUserMock.mockReset();
	});

	afterEach(() => {
		delete process.env.MU_SESSION_ID;
		process.chdir(originalCwd);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("registers ask_user and persists scope context for later prompts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-ask-user-preset-"));
		tempDirs.push(cwd);
		process.chdir(cwd);
		process.env.MU_SESSION_ID = "session-456";

		promptAskUserMock.mockResolvedValue({
			scopeName: "login-flow",
			sanitizedScopeName: "login-flow",
			answers: [
				{
					questionId: "surface",
					topic: "Surface",
					prompt: "Which surface?",
					answer: "cdp",
					source: "option",
					field: "surface",
					entryId: "login-flow",
				},
			],
			files: [],
			summary: "1. Surface: cdp",
		});

		type RegisteredTool = Parameters<ExtensionApi["registerTool"]>[0];
		let registeredTool: RegisteredTool | undefined;
		let contextHook: ((messages: Message[]) => Message[]) | undefined;
		const sessionEntries: unknown[] = [];

		askUserExtension({
			registerTool: (tool) => {
				registeredTool = tool;
			},
			registerCliTool: () => {},
			registerProvider: () => {},
			context: (hook) => {
				contextHook = hook as typeof contextHook;
			},
			registerCommand: () => {},
			input: () => {},
			beforeToolCall: () => {},
			afterToolResult: () => {},
			appendSessionEntry: (_customType, data) => {
				sessionEntries.push(data);
			},
			appendSessionMessage: () => {},
			getExtensionState: () => undefined,
			setExtensionState: () => {},
			registerExtensionIndicator: () => {},
			updateExtensionIndicator: () => {},
			removeExtensionIndicator: () => {},
			spawnAgent: async () => ({ result: "", exitCode: 0 }),
		});

		expect(registeredTool).toBeDefined();
		expect(contextHook).toBeDefined();

		const toolResult = await registeredTool!.execute("call_1", {
			mode: "validation_contract",
			objective: "Verify login flow",
			questions: [
				{
					id: "surface",
					prompt: "Which surface?",
					topic: "Surface",
					options: ["cdp", "xtui"],
				},
			],
		});
		const details = toolResult.details as { scopeName: string };

		expect(details.scopeName).toBe("login-flow");
		expect(sessionEntries).toHaveLength(1);

		const contextMessages = contextHook!([{ role: "user", content: "Implement the fix", timestamp: Date.now() }]);
		const injected = contextMessages.find(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.includes("Validation entries:"),
		);

		expect(injected).toBeDefined();
		expect(promptAskUserMock).toHaveBeenCalledTimes(1);
	});

	it("accepts clarify mode with arbitrary field keys without rejecting the tool call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-ask-user-clarify-"));
		tempDirs.push(cwd);
		process.chdir(cwd);
		process.env.MU_SESSION_ID = "session-789";

		promptAskUserMock.mockResolvedValue({
			scopeName: "dad-nursing-home-crisis",
			sanitizedScopeName: "dad-nursing-home-crisis",
			answers: [
				{
					questionId: "doctor_contacted",
					topic: "medical clearance",
					prompt: "Has anyone spoken to the doctor?",
					answer: "No, not yet",
					source: "option",
					field: "doctor_contacted",
				},
			],
			files: [],
			summary: "1. medical clearance: No, not yet",
		});

		type RegisteredTool = Parameters<ExtensionApi["registerTool"]>[0];
		let registeredTool: RegisteredTool | undefined;

		askUserExtension({
			registerTool: (tool) => {
				registeredTool = tool;
			},
			registerCliTool: () => {},
			registerProvider: () => {},
			context: () => {},
			registerCommand: () => {},
			input: () => {},
			beforeToolCall: () => {},
			afterToolResult: () => {},
			appendSessionEntry: () => {},
			appendSessionMessage: () => {},
			getExtensionState: () => undefined,
			setExtensionState: () => {},
			registerExtensionIndicator: () => {},
			updateExtensionIndicator: () => {},
			removeExtensionIndicator: () => {},
			spawnAgent: async () => ({ result: "", exitCode: 0 }),
		});

		expect(registeredTool).toBeDefined();

		const toolResult = await registeredTool!.execute("call_2", {
			mode: "clarify",
			objective: "Determine immediate safety status",
			scopeName: "Dad nursing home crisis",
			questions: [
				{
					id: "doctor_contacted",
					prompt: "Has anyone spoken to the doctor?",
					topic: "medical clearance",
					options: ["No, not yet", "Yes"],
					field: "doctor_contacted",
				},
			],
		});
		const details = toolResult.details as {
			scopeName: string;
			specClarifications: { items: Array<{ id: string; answer: string }> } | undefined;
		};

		expect(details.scopeName).toBe("dad-nursing-home-crisis");
		expect(details.specClarifications?.items.map((item) => ({ id: item.id, answer: item.answer }))).toEqual([
			{
				id: "doctor_contacted",
				answer: "No, not yet",
			},
		]);
	});
});
