import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function getProviderToolNames(context: Context): string[] {
	const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
	}
	return [...tools.keys()].sort();
}

describe("extension active tools next-turn refresh", () => {
	// Regression #6162
	it("applies pi.setActiveTools before the next provider request in the same run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerToolNames.push(getProviderToolNames(context));
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerToolNames.push(getProviderToolNames(context));
					return fauxAssistantMessage("done");
				},
			]);

			expect(harness.session.getActiveToolNames()).toEqual(["switch_tools"]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames()).toEqual(["after_switch"]);
			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves before_agent_start system prompt overrides when tools change mid-run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("before_agent_start", async (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nkeep this run override`,
				}));

				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerSystemPrompts: string[] = [];
			const providerToolNames: string[][] = [];
			const captureSystemPrompt = (context: Context): void => {
				providerSystemPrompts.push(
					context.messages
						.filter((message) => message.role === "system")
						.map((message) => (typeof message.content === "string" ? message.content : ""))
						.join("\n"),
				);
			};
			harness.setResponses([
				(context) => {
					captureSystemPrompt(context);
					providerToolNames.push(getProviderToolNames(context));
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					captureSystemPrompt(context);
					providerToolNames.push(getProviderToolNames(context));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("start");

			expect(providerToolNames).toEqual([["switch_tools"], ["after_switch"]]);
			expect(providerSystemPrompts).toHaveLength(2);
			expect(providerSystemPrompts[0]).toContain("keep this run override");
			expect(providerSystemPrompts[1]).toContain("keep this run override");
		} finally {
			harness.cleanup();
		}
	});
});
