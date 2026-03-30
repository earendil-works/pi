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
});
