import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { exportSessionForShare } from "../src/modes/interactive/session-share.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("JSONL share export", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adds presentation data without changing conversation IDs or links", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-jsonl-share-"));
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			tools: ["share_tool"],
			customTools: [
				defineTool({
					name: "share_tool",
					label: "Share Tool",
					description: "Render a value for sharing",
					parameters: Type.Object({ value: Type.String({ description: "Value to render" }) }),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				}),
			],
		});

		try {
			const userId = sessionManager.appendMessage(userMsg("hello"));
			const assistant: AssistantMessage = {
				...assistantMsg(""),
				content: [{ type: "toolCall", id: "call-1", name: "share_tool", arguments: { value: "example" } }],
				stopReason: "toolUse",
			};
			const assistantId = sessionManager.appendMessage(assistant);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "share_tool",
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			};
			const resultId = sessionManager.appendMessage(result);
			const originalEntryIds = sessionManager.getBranch().map((entry) => entry.id);

			const normalPath = join(tempDir, "normal.jsonl");
			session.exportToJsonl(normalPath);
			const normalRecords = readFileSync(normalPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(normalRecords.some((record) => record.type === "custom" && record.customType === "pi.share")).toBe(
				false,
			);

			const sharePath = join(tempDir, "share.jsonl");
			exportSessionForShare(sharePath, session);
			const records = readFileSync(sharePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const conversationRecords = records.slice(1, -1);
			expect(conversationRecords.map((record) => record.id)).toEqual(originalEntryIds);
			expect(conversationRecords.map((record) => record.parentId)).toEqual([null, ...originalEntryIds.slice(0, -1)]);
			expect(conversationRecords.slice(-3).map((record) => record.id)).toEqual([userId, assistantId, resultId]);

			const shareEntry = records.at(-1) as {
				id: string;
				data?: {
					systemPrompt?: string;
					tools?: Array<Record<string, unknown>>;
				};
			};
			expect(shareEntry).toMatchObject({
				type: "custom",
				customType: "pi.share",
				parentId: resultId,
				timestamp: expect.any(String),
			});
			expect(shareEntry.data?.systemPrompt).toBe(session.state.systemPrompt);
			expect(shareEntry.data?.tools).toEqual([
				expect.objectContaining({
					name: "share_tool",
					description: "Render a value for sharing",
				}),
			]);
			expect(shareEntry.data).not.toHaveProperty("renderedTools");
			expect(shareEntry.data).not.toHaveProperty("theme");
			expect(shareEntry.data).not.toHaveProperty("version");

			const imported = SessionManager.open(sharePath);
			expect(imported.getLeafId()).toBe(shareEntry.id);
			expect(imported.buildSessionContext().messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
			]);
		} finally {
			session.dispose();
		}
	});
});
