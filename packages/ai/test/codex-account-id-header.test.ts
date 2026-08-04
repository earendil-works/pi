import { describe, expect, it } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * An explicitly provided chatgpt-account-id header must win over JWT
 * extraction: not every ChatGPT access token carries the chatgpt_account_id
 * claim, and a caller that already knows the account (from the login
 * exchange) must be able to state it instead of failing the request.
 */

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.2-codex",
	name: "GPT-5.2 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function emptySseResponse(): Response {
	return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI Codex account id resolution", () => {
	it("prefers an explicit chatgpt-account-id header over JWT extraction", async () => {
		let capturedAccountId: string | null | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			capturedAccountId = new Headers(init?.headers).get("chatgpt-account-id");
			return emptySseResponse();
		};

		const stream = streamCodex(model, context, {
			apiKey: "opaque-token-without-account-claim",
			fetch: fetchMock as typeof fetch,
			headers: { "chatgpt-account-id": "acct-explicit" },
			transport: "sse",
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedAccountId).toBe("acct-explicit");
	});
});
