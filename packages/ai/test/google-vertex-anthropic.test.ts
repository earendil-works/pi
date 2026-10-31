import { describe, expect, it } from "vitest";
import { streamSimple as anthropicStreamSimple } from "../src/api/anthropic-messages.ts";
import {
	createVertexAnthropicFetch,
	VERTEX_ANTHROPIC_VERSION,
	vertexHost,
} from "../src/api/google-vertex-anthropic.ts";
import { hasApi } from "../src/models.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function capturingFetch(captured: CapturedRequest[]): typeof globalThis.fetch {
	return async (input, init) => {
		captured.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		});
		return new Response(JSON.stringify({ error: { type: "test", message: "captured" } }), { status: 400 });
	};
}

const target = { project: "my-project", location: "us-east5" };

describe("Claude on Vertex AI transport", () => {
	it("rewrites streaming Messages requests to streamRawPredict", async () => {
		const captured: CapturedRequest[] = [];
		const vertexFetch = createVertexAnthropicFetch(target, "ya29.token", capturingFetch(captured));
		await vertexFetch("https://us-east5-aiplatform.googleapis.com/v1/messages?beta=true", {
			method: "POST",
			headers: { "x-api-key": "ya29.token", "anthropic-beta": "some-beta" },
			body: JSON.stringify({ model: "claude-opus-4-8@default", stream: true, max_tokens: 10, messages: [] }),
		});

		expect(captured[0].url).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-opus-4-8@default:streamRawPredict",
		);
		expect(captured[0].headers.get("authorization")).toBe("Bearer ya29.token");
		expect(captured[0].headers.has("x-api-key")).toBe(false);
		expect(captured[0].headers.get("anthropic-beta")).toBe("some-beta");
		expect(captured[0].body).toEqual({
			anthropic_version: VERTEX_ANTHROPIC_VERSION,
			stream: true,
			max_tokens: 10,
			messages: [],
		});
	});

	it("uses rawPredict for non-streaming requests and keeps the model for token counting", async () => {
		const captured: CapturedRequest[] = [];
		const vertexFetch = createVertexAnthropicFetch(
			{ project: "p", location: "global" },
			"t",
			capturingFetch(captured),
		);
		await vertexFetch("https://aiplatform.googleapis.com/v1/messages", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5@20251001", messages: [] }),
		});
		await vertexFetch("https://aiplatform.googleapis.com/v1/messages/count_tokens", {
			method: "POST",
			body: JSON.stringify({ model: "claude-haiku-4-5@20251001", messages: [] }),
		});

		expect(captured[0].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict",
		);
		expect(captured[0].body).not.toHaveProperty("model");
		expect(captured[1].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/count-tokens:rawPredict",
		);
		expect(captured[1].body).toMatchObject({ model: "claude-haiku-4-5@20251001" });
	});

	it("maps the global location to the unprefixed host", () => {
		expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
		expect(vertexHost("europe-west1")).toBe("europe-west1-aiplatform.googleapis.com");
	});

	it("routes Anthropic SDK requests through the Vertex endpoint", async () => {
		const model = getBuiltinModels("google-vertex")
			.filter((candidate) => hasApi(candidate, "anthropic-messages"))
			.find((candidate) => candidate.id === "claude-opus-4-8@default") as Model<"anthropic-messages"> | undefined;
		if (!model) throw new Error("Vertex catalog has no claude-opus-4-8@default");
		const captured: CapturedRequest[] = [];
		const result = await anthropicStreamSimple(
			{ ...model, baseUrl: `https://${vertexHost(target.location)}` },
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ apiKey: "ya29.token", fetch: createVertexAnthropicFetch(target, "ya29.token", capturingFetch(captured)) },
		).result();

		expect(result.stopReason).toBe("error");
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/anthropic/models/claude-opus-4-8@default:streamRawPredict",
		);
		expect(captured[0].body).toMatchObject({ anthropic_version: VERTEX_ANTHROPIC_VERSION, stream: true });
		expect(captured[0].body).not.toHaveProperty("model");
		expect(captured[0].headers.get("authorization")).toBe("Bearer ya29.token");
	});

	it("lists Claude models on google-vertex through Anthropic Messages", () => {
		const claude = getBuiltinModels("google-vertex").filter((model) => model.id.startsWith("claude-"));
		expect(claude.length).toBeGreaterThan(0);
		for (const model of claude) expect(model.api).toBe("anthropic-messages");
	});
});
