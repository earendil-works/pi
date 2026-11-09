import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SideChatView } from "../../src/core/panes/side-chat.ts";
import { createSideSession } from "../../src/core/side-session.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const agents: Agent[] = [];
afterEach(async () => {
	for (const agent of agents.splice(0)) {
		agent.abort();
		await agent.waitForIdle();
	}
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function sideContext(): Promise<{ harness: Harness; context: ExtensionContext }> {
	const capture: { context?: ExtensionContext } = {};
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					capture.context = ctx;
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	if (!capture.context) throw new Error("Expected extension context after session start");
	return { harness, context: capture.context };
}

describe("temporary read-only side conversations", () => {
	it("inherits main context, reads files and rejects write/bash without changing main history", async () => {
		const { harness, context } = await sideContext();
		harness.setResponses([fauxAssistantMessage("Main answer")]);
		await harness.session.prompt("Main context marker ZX_104");
		const file = join(harness.tempDir, "note.txt");
		writeFileSync(file, "read-only marker");
		const before = JSON.stringify(harness.sessionManager.getEntries());
		const mainMessages = JSON.stringify(harness.session.messages);
		const side = createSideSession(context);
		agents.push(side);
		harness.setResponses([
			(request) => {
				expect(request.messages.some((message) => getMessageText(message).includes("ZX_104"))).toBe(true);
				expect(
					getCurrentTools(request.messages)
						.map((tool) => tool.name)
						.sort(),
				).toEqual(["find", "grep", "ls", "read"]);
				return fauxAssistantMessage([fauxToolCall("read", { path: file })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "changed" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 9" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Side answer"),
			fauxAssistantMessage("Follow-up answer"),
		]);
		await side.prompt("Inspect the note");
		await side.prompt("Explain that answer");
		const results = side.state.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(results.find((message) => message.toolName === "read"))).toContain("read-only marker");
		for (const name of ["write", "bash"])
			expect(results.find((message) => message.toolName === name)?.isError).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("read-only marker");
		expect(side.state.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"Follow-up answer",
		);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
		expect(JSON.stringify(harness.session.messages)).toBe(mainMessages);
		const view = new SideChatView(side, { invalidate() {}, close() {}, async minimize() {} });
		await view.dispose();
		expect(side.state.messages).toEqual([]);
		expect(side.peekQueuedMessages()).toEqual([]);
	});

	it("excludes an unfinished main tool round instead of fabricating tool results", async () => {
		const { harness, context } = await sideContext();
		harness.sessionManager.appendMessage({ role: "user", content: "Current work", timestamp: Date.now() });
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("bash", { command: "long operation" })], { stopReason: "toolUse" }),
		);
		const before = JSON.stringify(harness.sessionManager.getEntries());
		const side = createSideSession(context);
		agents.push(side);
		expect(
			side.state.messages.some((message) => message.role === "user" && getMessageText(message) === "Current work"),
		).toBe(true);
		expect(side.state.messages.some((message) => message.role === "assistant" || message.role === "toolResult")).toBe(
			false,
		);
		harness.setResponses([fauxAssistantMessage("Independent answer")]);
		await side.prompt("A side question while main is busy");
		expect(getMessageText(side.state.messages.at(-1))).toBe("Independent answer");
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
	});
});
