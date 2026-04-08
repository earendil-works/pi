import type { AgentTool, ToolResultMessage } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ExtensionRunner } from "./runner.js";
import { composeToolResultTransformer, wrapToolWithExtensions } from "./wrapper.js";

describe("extensions: tool wrapping", () => {
	it("before_tool_call can block execution", async () => {
		const schema = Type.Object({ text: Type.String() });

		let executed = false;
		const tool: AgentTool<typeof schema, { ok: true }> = {
			label: "Echo",
			name: "echo",
			description: "echo",
			parameters: schema,
			execute: async (_id, _params) => {
				executed = true;
				return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
			},
		};

		const runner = new ExtensionRunner();
		runner.registerBeforeToolCall(
			() => {
				return { type: "block", reason: "nope" };
			},
			{ sourceId: "test" },
		);

		const wrapped = wrapToolWithExtensions(tool, runner);

		await expect(wrapped.execute("tc_1", { text: "hi" })).rejects.toThrow(/nope/i);
		expect(executed).toBe(false);
	});

	it("after_tool_result hooks are applied via composed toolResultTransformer", () => {
		const runner = new ExtensionRunner();
		runner.registerAfterToolResult(
			(tr) => {
				return {
					...tr,
					content: [...tr.content, { type: "text", text: "patched" }],
				};
			},
			{ sourceId: "test" },
		);

		const transformer = composeToolResultTransformer(runner);

		const input: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "echo",
			content: [{ type: "text", text: "ok" }],
			details: { anything: true },
			isError: false,
			timestamp: Date.now(),
		};

		const out = transformer(input);
		const text = out.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		expect(text).toContain("ok");
		expect(text).toContain("patched");
	});
});

// VAL-CORE-004: Runtime-path proof that before-tool patches forward to underlying execution
describe("VAL-CORE-004: before_tool_call patch forwards to underlying execution", () => {
	it("forwards patched args from before-tool hook to underlying tool.execute", async () => {
		const schema = Type.Object({ value: Type.Number() });

		// Track what args were actually passed to the underlying tool
		let receivedArgs: { value: number } | null = null;
		const tool: AgentTool<typeof schema, { result: number }> = {
			label: "Double",
			name: "double",
			description: "doubles a number",
			parameters: schema,
			execute: async (_id, params) => {
				receivedArgs = params;
				return {
					content: [{ type: "text", text: String(params.value * 2) }],
					details: { result: params.value * 2 },
				};
			},
		};

		const runner = new ExtensionRunner();
		// Patch: multiply the input value by 10 before execution
		runner.registerBeforeToolCall(
			(event) => {
				const originalValue = (event.args as { value: number }).value;
				return { type: "patch", args: { value: originalValue * 10 } };
			},
			{ sourceId: "patcher" },
		);

		const wrapped = wrapToolWithExtensions(tool, runner);

		// Call with value=5, hook should patch to 50
		const result = await wrapped.execute("tc_1", { value: 5 });

		// Verify the underlying tool received the patched args (50, not 5)
		expect(receivedArgs).toEqual({ value: 50 });
		expect(result.details).toEqual({ result: 100 }); // 50 * 2 = 100
	});

	it("chains multiple before-tool patches, last patch wins for underlying execution", async () => {
		const schema = Type.Object({ text: Type.String() });

		let receivedArgs: { text: string } | null = null;
		const tool: AgentTool<typeof schema, { text: string }> = {
			label: "Echo",
			name: "echo",
			description: "echo",
			parameters: schema,
			execute: async (_id, params) => {
				receivedArgs = params;
				return { content: [{ type: "text", text: params.text }], details: { text: params.text } };
			},
		};

		const runner = new ExtensionRunner();
		// First patch: append "-first"
		runner.registerBeforeToolCall(
			(event) => {
				const text = (event.args as { text: string }).text;
				return { type: "patch", args: { text: `${text}-first` } };
			},
			{ sourceId: "first", priority: 10 }, // Higher priority runs first
		);
		// Second patch: append "-second"
		runner.registerBeforeToolCall(
			(event) => {
				const text = (event.args as { text: string }).text;
				return { type: "patch", args: { text: `${text}-second` } };
			},
			{ sourceId: "second", priority: 5 }, // Lower priority runs after
		);

		const wrapped = wrapToolWithExtensions(tool, runner);

		// Original: "hello"
		// After first patch (priority 10): "hello-first"
		// After second patch (priority 5): "hello-first-second"
		await wrapped.execute("tc_1", { text: "hello" });

		// Verify underlying tool received the fully patched args
		expect(receivedArgs).toEqual({ text: "hello-first-second" });
	});
});

// VAL-CORE-005: Runtime-path proof that after-tool-result transformer is composable
describe("VAL-CORE-005: after_tool_result transformer composes through runtime path", () => {
	it("composeToolResultTransformer chains multiple hooks in priority order", () => {
		const runner = new ExtensionRunner();

		// First hook: add "a" property
		runner.registerAfterToolResult(
			(tr) => ({
				...tr,
				details: { ...(tr.details as Record<string, unknown>), a: 1 },
			}),
			{ sourceId: "first", priority: 10 },
		);

		// Second hook: add "b" property (sees "a" from first hook)
		runner.registerAfterToolResult(
			(tr) => ({
				...tr,
				details: { ...(tr.details as Record<string, unknown>), b: 2 },
			}),
			{ sourceId: "second", priority: 5 },
		);

		const transformer = composeToolResultTransformer(runner);

		const input: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "test",
			content: [{ type: "text", text: "ok" }],
			details: { original: true },
			isError: false,
			timestamp: Date.now(),
		};

		const out = transformer(input);

		// Both patches should be applied
		expect(out.details).toEqual({ original: true, a: 1, b: 2 });
	});

	it("composeToolResultTransformer integrates with base transformer", () => {
		const runner = new ExtensionRunner();

		runner.registerAfterToolResult(
			(tr) => ({
				...tr,
				details: { ...(tr.details as Record<string, unknown>), ext: true },
			}),
			{ sourceId: "ext" },
		);

		// Base transformer adds timestamp
		const baseTransformer = (tr: ToolResultMessage<unknown>): ToolResultMessage<unknown> => ({
			...tr,
			details: { ...(tr.details as Record<string, unknown>), baseTimestamp: 12345 },
		});

		const transformer = composeToolResultTransformer(runner, baseTransformer);

		const input: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "test",
			content: [{ type: "text", text: "ok" }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		};

		const out = transformer(input);

		// Extension hook runs first, then base transformer
		expect(out.details).toEqual({ ext: true, baseTimestamp: 12345 });
	});
});
