import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function expectValidToolPairing(messages: AgentMessage[]): void {
	const pendingToolCalls = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					pendingToolCalls.add(part.id);
				}
			}
		} else if (message.role === "toolResult") {
			expect(pendingToolCalls.has(message.toolCallId)).toBe(true);
			pendingToolCalls.delete(message.toolCallId);
		}
	}
	expect(pendingToolCalls.size).toBe(0);
}

describe("AgentSession active-run tree navigation", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects navigation until a deferred tool run settles without corrupting persisted context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-tree-navigation-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");
		const sessionManager = SessionManager.create(tempDir, sessionDir);
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until the test releases the tool",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ sessionManager, tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("seed reply"),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool run complete"),
		]);

		await harness.session.prompt("seed");
		const seedUserEntry = sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(seedUserEntry).toBeDefined();

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("run deferred tool");
		await sawToolStart;
		const originatingLeafId = sessionManager.getLeafId();

		try {
			await expect(harness.session.navigateTree(originatingLeafId!)).resolves.toEqual({ cancelled: false });
			await expect(harness.session.navigateTree(seedUserEntry!.id)).rejects.toThrow(
				"Cannot navigate the session tree while an agent run is active",
			);
			expect(sessionManager.getLeafId()).toBe(originatingLeafId);
		} finally {
			releaseToolExecution?.();
		}
		await promptPromise;

		const persistedPath = sessionManager.getSessionFile();
		expect(persistedPath).toBeDefined();
		const reopened = SessionManager.open(persistedPath!, sessionDir, tempDir);
		const reopenedContext = reopened.buildSessionContext().messages;
		expectValidToolPairing(reopenedContext);
		expect(reopened.getLeafId()).toBe(sessionManager.getLeafId());
		expect(reopenedContext.filter((message) => message.role === "toolResult")).toHaveLength(1);

		harness.setResponses([
			(context) => {
				expectValidToolPairing(context.messages);
				return fauxAssistantMessage("context valid");
			},
		]);
		await harness.session.prompt("verify context");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("context valid");
	});
});
