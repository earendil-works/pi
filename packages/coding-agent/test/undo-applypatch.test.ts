import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../src/session-manager.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { undoFileOperations } from "../src/undo/undo-file-operations.js";

describe("undo apply_patch", () => {
	let testDir: string;
	let previousCwd: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "coding-agent-undo-applypatch-"));
		previousCwd = process.cwd();
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reverts ApplyPatch changes using session-stored undo payload when in-memory details are stripped", async () => {
		const sessionFile = join(testDir, "session.jsonl");
		const sessionManager = new SessionManager(false, sessionFile, false, testDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		writeFileSync(join(testDir, "a.txt"), "hello world\n", "utf8");

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-hello world",
			"+hello mu",
			"*** Add File: b.txt",
			"+new file",
			"*** End Patch",
		].join("\n");

		const toolResult = await applyPatchTool.execute("tc_applypatch", { input: patch });

		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc_applypatch",
			toolName: "apply_patch",
			content: toolResult.content,
			details: toolResult.details,
			isError: false,
			timestamp: Date.now(),
		};

		// Persist full details (including undo payload) to session file.
		sessionManager.saveMessage(toolResultMessage);

		// In-memory details are stripped (simulating the TUI behavior after saving)
		toolResultMessage.details = { parsed: toolResult.details.parsed };

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc_applypatch", name: "apply_patch", arguments: { input: patch } }],
			api: "openai-completions",
			provider: "test",
			model: "test",
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

		// Sanity: patch applied
		expect(await readFile(join(testDir, "a.txt"), "utf8")).toBe("hello mu\n");
		expect(await readFile(join(testDir, "b.txt"), "utf8")).toBe("new file\n");

		const result = await undoFileOperations({
			cwd: testDir,
			sessionManager,
			messagesToUndo: [assistantMessage, toolResultMessage],
		});

		expect(result.warnings).toEqual([]);
		expect(await readFile(join(testDir, "a.txt"), "utf8")).toBe("hello world\n");
		await expect(readFile(join(testDir, "b.txt"), "utf8")).rejects.toThrow();
	});

	it("refuses to undo when file content has changed since ApplyPatch", async () => {
		const sessionFile = join(testDir, "session.jsonl");
		const sessionManager = new SessionManager(false, sessionFile, false, testDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		writeFileSync(join(testDir, "a.txt"), "hello world\n", "utf8");

		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-hello world",
			"+hello mu",
			"*** End Patch",
		].join("\n");

		const toolResult = await applyPatchTool.execute("tc_applypatch", { input: patch });
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tc_applypatch",
			toolName: "apply_patch",
			content: toolResult.content,
			details: toolResult.details,
			isError: false,
			timestamp: Date.now(),
		};
		sessionManager.saveMessage(toolResultMessage);
		toolResultMessage.details = { parsed: toolResult.details.parsed };

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc_applypatch", name: "apply_patch", arguments: { input: patch } }],
			api: "openai-completions",
			provider: "test",
			model: "test",
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

		// Simulate concurrent modification.
		writeFileSync(join(testDir, "a.txt"), "hello mu\nCONCURRENT\n", "utf8");

		const result = await undoFileOperations({
			cwd: testDir,
			sessionManager,
			messagesToUndo: [assistantMessage, toolResultMessage],
		});

		expect(result.warnings.join("\n")).toContain("content has changed");
		expect(await readFile(join(testDir, "a.txt"), "utf8")).toBe("hello mu\nCONCURRENT\n");
	});
});
