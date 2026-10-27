import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Runs the real Anthropic SDK against a fake fetch to check how often the
// workload identity federation token exchange happens.
// https://github.com/earendil-works/pi/issues/10177

function sseResponse(): Response {
	const body = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
		})}\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RecordedRequest {
	path: string;
	authorization: string | null;
}

function createFetch(requests: RecordedRequest[]): typeof globalThis.fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		requests.push({ path, authorization: request.headers.get("authorization") });
		if (path === "/v1/oauth/token") {
			return new Response(JSON.stringify({ access_token: "federated-token", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return sseResponse();
	};
}

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

let tempDir: string;
let federationEnv: Record<string, string>;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-anthropic-federation-"));
	const identityTokenFile = join(tempDir, "identity.jwt");
	writeFileSync(identityTokenFile, "header.payload.signature");
	federationEnv = {
		ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
		ANTHROPIC_ORGANIZATION_ID: "org-test",
		ANTHROPIC_IDENTITY_TOKEN_FILE: identityTokenFile,
	};
});

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Anthropic workload identity federation with the SDK", () => {
	it("exchanges the identity token once across requests", async () => {
		const requests: RecordedRequest[] = [];
		const fetch = createFetch(requests);

		for (let i = 0; i < 3; i++) {
			const message = await streamAnthropic(anthropicModel, context, { env: federationEnv, fetch }).result();
			expect(message.stopReason).toBe("stop");
		}

		expect(requests.filter((request) => request.path === "/v1/oauth/token")).toHaveLength(1);
		const messageRequests = requests.filter((request) => request.path === "/v1/messages");
		expect(messageRequests).toHaveLength(3);
		for (const request of messageRequests) {
			expect(request.authorization).toBe("Bearer federated-token");
		}
	});

	it("does not run the SDK credential chain for header-owned auth", async () => {
		for (const [name, value] of Object.entries(federationEnv)) vi.stubEnv(name, value);
		const requests: RecordedRequest[] = [];

		const message = await streamAnthropic(anthropicModel, context, {
			headers: { Authorization: "Bearer auth-token" },
			fetch: createFetch(requests),
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toEqual([{ path: "/v1/messages", authorization: "Bearer auth-token" }]);
	});
});
