import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("registers ask_user and returns answers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-ask-user-preset-"));
		tempDirs.push(cwd);
		process.chdir(cwd);
		process.env.MU_SESSION_ID = "session-456";

		promptAskUserMock.mockResolvedValue({
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
			summary: "1. Surface: cdp",
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
		const details = toolResult.details as { answers: Array<{ answer: string }> };

		expect(details.answers).toHaveLength(1);
		expect(details.answers[0]?.answer).toBe("cdp");
		expect(promptAskUserMock).toHaveBeenCalledTimes(1);
	});

	it("accepts clarify mode with arbitrary field keys without rejecting the tool call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mu-ask-user-clarify-"));
		tempDirs.push(cwd);
		process.chdir(cwd);
		process.env.MU_SESSION_ID = "session-789";

		promptAskUserMock.mockResolvedValue({
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
		const details = toolResult.details as { answers: Array<{ answer: string }> };

		expect(details.answers).toHaveLength(1);
		expect(details.answers[0]?.answer).toBe("No, not yet");
	});
});
