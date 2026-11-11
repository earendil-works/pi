import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAiGatewayCatalog } from "../catalog/sources/vercel-ai-gateway.ts";
import { createModels } from "../src/models.ts";
import { vercelAIGatewayProvider } from "../src/providers/vercel-ai-gateway.ts";

afterEach(() => vi.restoreAllMocks());

describe("Vercel AI Gateway API routing", () => {
	it("selects Responses only for OpenAI chat models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				data: [
					{ id: "openai/gpt-6.1-sol", tags: ["tool-use", "reasoning"] },
					{ id: "anthropic/claude-opus-5.5", tags: ["tool-use", "reasoning"] },
					{ id: "google/gemini-test", tags: ["tool-use"] },
					{ id: "typesafe-ai/jev", type: "evaluation" },
				],
			}),
		);
		const catalog = await fetchAiGatewayCatalog();
		expect(catalog.chat[0]).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
		});
		expect(catalog.chat[0].compat ?? {}).not.toHaveProperty("allowEmptySignature");
		for (const model of catalog.chat.slice(1)) {
			expect(model).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://ai-gateway.vercel.sh",
				compat: { allowEmptySignature: true },
			});
		}
		expect(catalog.classifiers[0]).toMatchObject({
			api: "typesafe-system-one",
			baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1",
		});
	});

	it.each([
		["openai/", "openai-responses", "/v1/responses"],
		["anthropic/", "anthropic-messages", "/v1/messages"],
	] as const)("dispatches catalog models under %s through %s", async (prefix, api, path) => {
		const models = createModels();
		models.setProvider(vercelAIGatewayProvider());
		const model = models.getModels("vercel-ai-gateway").find((model) => model.id.startsWith(prefix));
		if (!model) throw new Error(`Missing gateway model under ${prefix}`);
		expect(model.api).toBe(api);
		let url: string | undefined;
		await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{
				apiKey: "test-key",
				maxRetries: 0,
				fetch: async (input) => {
					url = String(input);
					return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
				},
			},
		);
		expect(new URL(url!).origin + new URL(url!).pathname).toBe(`https://ai-gateway.vercel.sh${path}`);
	});
});
