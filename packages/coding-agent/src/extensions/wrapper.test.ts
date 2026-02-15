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
