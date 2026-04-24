import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { stream } from "../src/stream.js";
import type { Context, Tool } from "../src/types.js";
import { resolveApiKey } from "./oauth.js";

const oauthToken = await resolveApiKey("anthropic");

/**
 * Tests for Anthropic OAuth tool name normalization.
 *
 * When using Claude Code OAuth, tool names must match CC's canonical casing.
 * The normalization should:
 * 1. Convert tool names that match CC tools (case-insensitive) to CC casing on outbound
 * 2. Convert tool names back to the original casing on inbound
 *
 * This is a simple case-insensitive lookup, NOT a mapping of different names.
 * e.g., "todowrite" -> "TodoWrite" -> "todowrite" (round-trip works)
 *
 * The old `find -> Glob` mapping was WRONG because:
 * - Outbound: "find" -> "Glob"
 * - Inbound: "Glob" -> ??? (no tool named "glob" in context.tools, only "find")
 * - Result: tool call has name "Glob" but no tool exists with that name
 */
describe.skipIf(!oauthToken)("Anthropic OAuth tool name normalization", () => {
	const model = getModel("anthropic", "claude-sonnet-4-20250514");

	it("should normalize user-defined tool matching CC name (todowrite -> TodoWrite -> todowrite)", async () => {
		// User defines a tool named "todowrite" (lowercase)
		// CC has "TodoWrite" - this should round-trip correctly
		const todoTool: Tool = {
			name: "todowrite",
			description: "Write a todo item",
			parameters: Type.Object({
				task: Type.String({ description: "The task to add" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the todowrite tool when asked to add todos.",
			messages: [
				{
					role: "user",
					content: "Add a todo: buy milk. Use the todowrite tool.",
					timestamp: Date.now(),
				},
			],
			tools: [todoTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// The tool call should come back with the ORIGINAL name "todowrite", not "TodoWrite"
		expect(toolCallName).toBe("todowrite");
	});

	it("should handle pi's built-in tools (read, write, edit, bash)", async () => {
		// Pi's tools use lowercase names, CC uses PascalCase
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String({ description: "File path" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the read tool to read files.",
			messages: [
				{
					role: "user",
					content: "Read the file /tmp/test.txt using the read tool.",
					timestamp: Date.now(),
				},
			],
			tools: [readTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// The tool call should come back with the ORIGINAL name "read", not "Read"
		expect(toolCallName).toBe("read");
	});

	it("should NOT map find to Glob - find is not a CC tool name", async () => {
		// Pi has a "find" tool, CC has "Glob" - these are DIFFERENT tools
		// The old code incorrectly mapped find -> Glob, which broke the round-trip
		// because there's no tool named "glob" in context.tools
		const findTool: Tool = {
			name: "find",
			description: "Find files by pattern",
			parameters: Type.Object({
				pattern: Type.String({ description: "Glob pattern" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the find tool to search for files.",
			messages: [
				{
					role: "user",
					content: "Find all .ts files using the find tool.",
					timestamp: Date.now(),
				},
			],
			tools: [findTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// With the BROKEN find -> Glob mapping:
		// - Sent as "Glob" to Anthropic
		// - Received back as "Glob"
		// - fromClaudeCodeName("Glob", tools) looks for tool.name.toLowerCase() === "glob"
		// - No match (tool is named "find"), returns "Glob"
		// - Test fails: toolCallName is "Glob" instead of "find"
		//
		// With the CORRECT implementation (no find->Glob mapping):
		// - Sent as "find" to Anthropic (no CC tool named "Find")
		// - Received back as "find"
		// - Test passes: toolCallName is "find"
		expect(toolCallName).toBe("find");
	});

	it("should handle custom tools that don't match any CC tool names", async () => {
		// A completely custom tool should pass through unchanged
		const customTool: Tool = {
			name: "my_custom_tool",
			description: "A custom tool",
			parameters: Type.Object({
				input: Type.String({ description: "Input value" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use my_custom_tool when asked.",
			messages: [
				{
					role: "user",
					content: "Use my_custom_tool with input 'hello'.",
					timestamp: Date.now(),
				},
			],
			tools: [customTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// Custom tool names should pass through unchanged
		expect(toolCallName).toBe("my_custom_tool");
	});
});
