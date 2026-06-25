import { describe, expect, it } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: `What is ${(Math.random() * 100) | 0} + ${(Math.random() * 100) | 0}? Think step by step.`,
				timestamp: Date.now(),
			},
		],
	};
}

describe.skipIf(!process.env.OPENAI_API_KEY)("xhigh reasoning", () => {
	describe("codex-max (supports xhigh)", () => {
		// Note: codex models only support the responses API, not chat completions
		it("should work with openai-responses", async () => {
			const model = getModel("openai", "gpt-5.1-codex-max");
			const s = stream(model, makeContext(), { reasoningEffort: "xhigh" });
			let hasThinking = false;

			for await (const event of s) {
				if (event.type === "thinking_start" || event.type === "thinking_delta") {
					hasThinking = true;
				}
			}

			const response = await s.result();
			expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
			expect(response.content.some((b) => b.type === "text")).toBe(true);
			expect(hasThinking || response.content.some((b) => b.type === "thinking")).toBe(true);
		});
	});

	describe("gpt-5-mini (does not support xhigh)", () => {
		it("should error with openai-responses when using xhigh", async () => {
			const model = getModel("openai", "gpt-5-mini");
			const s = stream(model, makeContext(), { reasoningEffort: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});

		it("should error with openai-completions when using xhigh", async () => {
			const { compat: _compat, ...baseModel } = getModel("openai", "gpt-5-mini");
			void _compat;
			const model: Model<"openai-completions"> = {
				...baseModel,
				api: "openai-completions",
			};
			const s = stream(model, makeContext(), { reasoningEffort: "xhigh" });

			for await (const _ of s) {
				// drain events
			}

			const response = await s.result();
			expect(response.stopReason).toBe("error");
			expect(response.errorMessage).toContain("xhigh");
		});
	});
});
