import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/bedrock-mantle.ts";
import { hasApi } from "../src/models.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function mantleModels(): Model<"openai-responses">[] {
	return getBuiltinModels("amazon-bedrock").filter((model) => hasApi(model, "openai-responses"));
}

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("Bedrock Mantle", () => {
	let savedToken: string | undefined;
	beforeEach(() => {
		savedToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	});
	afterEach(() => {
		if (savedToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		else process.env.AWS_BEARER_TOKEN_BEDROCK = savedToken;
	});

	it("routes models Converse does not serve to the Mantle Responses endpoint", () => {
		const models = mantleModels();
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.baseUrl).toMatch(/^https:\/\/bedrock-mantle\.\{region\}\.api\.aws\//);
		}
		const converse = getBuiltinModels("amazon-bedrock").filter((model) => hasApi(model, "bedrock-converse-stream"));
		expect(converse.some((model) => model.id.includes("anthropic.claude"))).toBe(true);
	});

	it("lists Mantle models from AWS's model cards that models.dev does not", () => {
		const ids = mantleModels().map((model) => model.id);
		expect(ids).toEqual(expect.arrayContaining(["openai.gpt-5.6-cyber", "openai.gpt-daybreak-blue-5.6-sol"]));
	});

	it("uses strict tool schemas on Mantle models that support structured output", () => {
		const model = mantleModels().find((candidate) => candidate.id === "openai.gpt-5.6-sol");
		expect(model?.compat).toMatchObject({ supportsStrictMode: true, supportsLongCacheRetention: false });
	});

	it("sends Responses requests to the regional Mantle host with the Bedrock API key", async () => {
		const model = mantleModels()[0];
		const requests: { url: string; authorization: string | null }[] = [];
		const result = await streamSimple(model, context, {
			apiKey: "bedrock-api-key",
			env: { AWS_REGION: "us-west-2" },
			fetch: async (input, init) => {
				requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
				return new Response(JSON.stringify({ error: { message: "captured" } }), { status: 400 });
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(requests[0]).toEqual({
			url: `${model.baseUrl.replace("{region}", "us-west-2")}/responses`,
			authorization: "Bearer bedrock-api-key",
		});
	});

	it("signs requests with SigV4 for bedrock-mantle when no Bedrock API key is set", async () => {
		const model = mantleModels()[0];
		const requests: { url: string; headers: Headers; body: string }[] = [];
		const result = await streamSimple(model, context, {
			env: {
				AWS_REGION: "eu-west-1",
				AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
				AWS_SESSION_TOKEN: "session-token",
			},
			fetch: async (input, init) => {
				requests.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
				return new Response(JSON.stringify({ error: { message: "captured" } }), { status: 400 });
			},
		}).result();

		expect(result.stopReason).toBe("error");
		const request = requests[0];
		expect(request.url).toBe(`${model.baseUrl.replace("{region}", "eu-west-1")}/responses`);
		expect(request.headers.get("authorization")).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock-mantle\/aws4_request, SignedHeaders=[^,]*content-type[^,]*host[^,]*, Signature=[0-9a-f]{64}$/,
		);
		expect(request.headers.get("x-amz-security-token")).toBe("session-token");
		expect(request.headers.get("x-amz-content-sha256") ?? request.headers.get("x-amz-date")).toBeTruthy();
		expect(JSON.parse(request.body)).toMatchObject({ model: model.id });
	});

	it("prefers a Bedrock API key over AWS credentials", async () => {
		let authorization: string | null = null;
		await streamSimple(mantleModels()[0], context, {
			env: {
				AWS_BEARER_TOKEN_BEDROCK: "env-key",
				AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
				AWS_SECRET_ACCESS_KEY: "secret",
			},
			fetch: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				return new Response("{}", { status: 400 });
			},
		}).result();
		expect(authorization).toBe("Bearer env-key");
	});
});
