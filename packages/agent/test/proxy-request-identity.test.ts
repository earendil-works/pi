import type { AgentRequestIdentity, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

afterEach(() => vi.unstubAllGlobals());

describe("streamProxy request identity", () => {
	it("serializes requestIdentity without modification", async () => {
		const requestIdentity: AgentRequestIdentity = {
			sessionId: "session",
			threadId: "thread",
			turnId: "turn",
			requestKind: "turn",
			startedAt: 123,
			windowId: "window",
		};
		let body: { options?: { requestIdentity?: AgentRequestIdentity } } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return new Response("proxy failed", { status: 500, statusText: "Error" });
			}),
		);
		const model = {
			id: "mock",
			name: "Mock",
			api: "custom",
			provider: "custom",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		} satisfies Model<"custom">;
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

		await streamProxy(model, context, {
			authToken: "token",
			proxyUrl: "https://proxy.invalid",
			requestIdentity,
		}).result();

		expect(body?.options?.requestIdentity).toEqual(requestIdentity);
	});
});
