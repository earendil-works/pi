import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "copilot-test-model",
	name: "Copilot test model",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://copilot.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

describe("Copilot HTTP request-size errors", () => {
	it.each([
		{ status: 413, nested: true, overflow: true },
		{ status: 413, nested: false, overflow: true },
		{ status: 400, nested: true, overflow: false },
	])("classifies HTTP $status with nested=$nested through the real SDK", async ({ status, nested, overflow }) => {
		const error = { message: "failed to parse request", code: "" };
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(JSON.stringify(nested ? { error } : error), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Continue", timestamp: 0 }] }),
			{ apiKey: "test-key", fetch, maxRetries: 0 },
		).result();

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.provider).toBe("github-copilot");
		expect(result.stopReason).toBe("error");
		expect(result.usage.totalTokens).toBe(0);
		expect(result.errorMessage).toContain(`(${status})`);
		expect(result.errorMessage).toContain("failed to parse request");
		expect(isContextOverflow(result, model.contextWindow)).toBe(overflow);
	});
});
