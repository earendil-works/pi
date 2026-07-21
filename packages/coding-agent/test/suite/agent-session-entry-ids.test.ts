import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession entry IDs", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("persists a reserved user ID and emits stable entries after message_end", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const userEntryId = harness.sessionManager.reserveEntryId("maverick-user-entry");

		await harness.session.prompt("use the tool", { userEntryId });

		const appendedEntries = harness.eventsOfType("entry_appended").map((event) => event.entry);
		const messageEntries = appendedEntries.filter((entry) => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(messageEntries[0]?.id).toBe(userEntryId);
		expect(new Set(messageEntries.map((entry) => entry.id)).size).toBe(messageEntries.length);
		for (const entry of messageEntries) {
			expect(harness.sessionManager.getEntry(entry.id)).toBe(entry);
		}

		const userMessageEndIndex = harness.events.findIndex(
			(event) => event.type === "message_end" && event.message.role === "user",
		);
		const userEntryIndex = harness.events.findIndex(
			(event) => event.type === "entry_appended" && event.entry.id === userEntryId,
		);
		expect(userMessageEndIndex).toBeGreaterThanOrEqual(0);
		expect(userEntryIndex).toBeGreaterThan(userMessageEndIndex);
	});

	it("preserves reserved IDs through skill and prompt-template expansion without provider metadata", async () => {
		const tempDir = join(tmpdir(), `pi-entry-id-expansion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: join(tempDir, "review.md"),
			sourceInfo: createSyntheticSourceInfo(join(tempDir, "review.md"), {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const providerUsers: unknown[] = [];
		harness.setResponses([
			(context) => {
				providerUsers.push(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage("skill done");
			},
			(context) => {
				providerUsers.push(context.messages.filter((message) => message.role === "user").at(-1));
				return fauxAssistantMessage("template done");
			},
		]);
		const skillEntryId = harness.sessionManager.reserveEntryId("skill-user-entry");
		const templateEntryId = harness.sessionManager.reserveEntryId("template-user-entry");

		await harness.session.prompt("/skill:test explain this", { userEntryId: skillEntryId });
		await harness.session.prompt("/review src/index.ts", { userEntryId: templateEntryId });

		const skillEntry = harness.sessionManager.getEntry(skillEntryId);
		const templateEntry = harness.sessionManager.getEntry(templateEntryId);
		expect(skillEntry?.type).toBe("message");
		expect(templateEntry?.type).toBe("message");
		if (skillEntry?.type === "message") {
			expect(getMessageText(skillEntry.message)).toContain('<skill name="test" location="');
			expect(getMessageText(skillEntry.message)).toContain("explain this");
		}
		if (templateEntry?.type === "message") {
			expect(getMessageText(templateEntry.message)).toBe("Review this code: src/index.ts");
		}
		expect(providerUsers).toHaveLength(2);
		for (const user of providerUsers) {
			expect(user).not.toHaveProperty("id");
		}
	});

	it("preserves distinct reserved IDs for identical queued messages", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("follow-ups complete"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		const firstEntryId = harness.sessionManager.reserveEntryId("queued-user-1");
		const secondEntryId = harness.sessionManager.reserveEntryId("queued-user-2");

		await harness.session.prompt("same", { streamingBehavior: "followUp", userEntryId: firstEntryId });
		await harness.session.prompt("same", { streamingBehavior: "followUp", userEntryId: secondEntryId });
		releaseToolExecution?.();
		await promptPromise;

		const queuedEntries = harness
			.eventsOfType("entry_appended")
			.map((event) => event.entry)
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "user" && getMessageText(entry.message) === "same",
			);
		expect(queuedEntries.map((entry) => entry.id)).toEqual([firstEntryId, secondEntryId]);
	});

	it("releases reserved IDs when an extension command handles the prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("handled", {
						description: "Handle without a user message",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);
		const entryId = harness.sessionManager.reserveEntryId("handled-command-entry");

		await expect(harness.session.prompt("/handled", { userEntryId: entryId })).rejects.toThrow(
			"Prompt was handled as an extension command and did not create a user entry",
		);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.sessionManager.reserveEntryId(entryId)).toBe(entryId);
	});

	it("releases reserved IDs when an input extension handles the prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		harnesses.push(harness);
		const entryId = harness.sessionManager.reserveEntryId("handled-input-entry");

		await expect(harness.session.prompt("handled", { userEntryId: entryId })).rejects.toThrow(
			"Prompt was handled by an input extension and did not create a user entry",
		);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.sessionManager.reserveEntryId(entryId)).toBe(entryId);
	});

	it("releases the exact reserved IDs for queued messages that are cleared", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		const firstEntryId = harness.sessionManager.reserveEntryId("cancelled-user-1");
		const secondEntryId = harness.sessionManager.reserveEntryId("cancelled-user-2");
		await harness.session.prompt("same", { streamingBehavior: "followUp", userEntryId: firstEntryId });
		await harness.session.prompt("same", { streamingBehavior: "followUp", userEntryId: secondEntryId });

		expect(harness.session.clearQueue()).toEqual({
			steering: [],
			followUp: ["same", "same"],
			cancelledEntryIds: [firstEntryId, secondEntryId],
		});
		expect(harness.sessionManager.reserveEntryId(firstEntryId)).toBe(firstEntryId);
		expect(harness.sessionManager.reserveEntryId(secondEntryId)).toBe(secondEntryId);
		releaseToolExecution?.();
		await promptPromise;

		const deliveredUserTexts = harness
			.eventsOfType("entry_appended")
			.flatMap((event) =>
				event.entry.type === "message" && event.entry.message.role === "user"
					? [getMessageText(event.entry.message)]
					: [],
			);
		expect(deliveredUserTexts).toEqual(["start"]);
	});
});
