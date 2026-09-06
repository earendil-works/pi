import { describe, expect, it } from "vitest";
import {
	type AiBinding,
	CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
	createAiBindingFetch,
} from "../src/api/cloudflare-ai-binding.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

const BINDING_PREFIX = "https://workers-binding.ai/ai-gateway/gateways/my-gateway";

function fakeBinding(response?: Response) {
	const requests: Request[] = [];
	const binding: AiBinding = {
		aiGatewayLogId: null,
		fetch: (input: Request | string | URL, init?: RequestInit) => {
			requests.push(input instanceof Request ? input : new Request(input, init));
			return Promise.resolve(response ?? new Response("{}"));
		},
	};
	return { binding, requests };
}

describe("createAiBindingFetch", () => {
	it("passes requests to the binding untouched", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.close();
			},
		});
		const bindingResponse = new Response(stream, {
			headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-1" },
		});
		const { binding, requests } = fakeBinding(bindingResponse);
		// No cast at the call site: an `Ai` binding is accepted as-is, the way `env.AI` is typed.
		const fetchFn = createAiBindingFetch(binding);
		const body = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] });

		const response = await fetchFn(`${BINDING_PREFIX}/anthropic/v1/messages?beta=true`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
				"anthropic-version": "2023-06-01",
			},
			body,
		});

		expect(requests[0].url).toBe(`${BINDING_PREFIX}/anthropic/v1/messages?beta=true`);
		expect(requests[0].method).toBe("POST");
		expect(Object.fromEntries(requests[0].headers)).toEqual({
			"content-type": "application/json",
			// The gateway recognizes and strips the sentinel itself; nothing here touches headers.
			"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
			"anthropic-version": "2023-06-01",
		});
		expect(await requests[0].text()).toBe(body);
		expect(response).toBe(bindingResponse);
		expect(await response.text()).toBe("data: {}\n\n");
	});

	it("rejects a binding with no fetch() at construction, not on first request", () => {
		// A well-typed binding on a runtime that predates `Ai#fetch`: `fetch` is optional on the
		// type, so the check has to happen at runtime — early, with a message that names the cause.
		expect(() => createAiBindingFetch({ aiGatewayLogId: null })).toThrow("does not expose fetch()");
	});

	it("keeps SDK placeholder auth off the wire when paired with null auth headers", async () => {
		// The full header contract from the module docs, end to end through a real API impl: the
		// sentinel satisfies pi's request-auth check, and the explicit nulls make the OpenAI SDK
		// delete its own `Authorization: Bearer unused` placeholder before dispatch.
		const { binding, requests } = fakeBinding(
			Response.json({ error: { type: "bad_request", message: "stubbed" } }, { status: 400 }),
		);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${BINDING_PREFIX}/openai`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				headers: {
					"cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
					Authorization: null,
					"x-api-key": null,
				},
				fetch: createAiBindingFetch(binding),
				maxRetries: 0,
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(`${BINDING_PREFIX}/openai/chat/completions`);
		const headerNames = Object.keys(Object.fromEntries(requests[0].headers));
		expect(headerNames).not.toContain("authorization");
		expect(headerNames).not.toContain("x-api-key");
	});
});
