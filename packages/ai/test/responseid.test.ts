import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { resolveApiKey } from "./oauth.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const oauthTokens = await Promise.all([resolveApiKey("github-copilot"), resolveApiKey("openai-codex")]);
const [githubCopilotToken, openaiCodexToken] = oauthTokens;

async function expectResponseId<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe("Google Vertex Provider", () => {
		const vertexProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
		const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION;
		const vertexApiKey = process.env.GOOGLE_CLOUD_API_KEY;
		const isVertexConfigured = Boolean(vertexProject && vertexLocation);
		const vertexOptions = { project: vertexProject, location: vertexLocation } as const;
		const llm = getModel("google-vertex", "gemini-3-flash-preview");

		it.skipIf(!isVertexConfigured)("should expose responseId with ADC", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm, vertexOptions);
		});

		it.skipIf(!vertexApiKey)("should expose responseId with API key", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm, { apiKey: vertexApiKey! });
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-5");

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)("OpenAI path should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const llm = getModel("github-copilot", "gpt-5.3-codex");
			await expectResponseId(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)(
			"Anthropic path should expose responseId",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.5");
				await expectResponseId(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			const llm = getModel("openai-codex", "gpt-5.2-codex");
			await expectResponseId(llm, { apiKey: openaiCodexToken });
		});
	});
});
