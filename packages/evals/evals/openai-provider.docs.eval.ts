import { afterAll, beforeAll, beforeEach } from "vitest";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import {
	createAcmeServer,
	OPENAI_MODEL_ID,
	OPENAI_PROBE_PROMPT,
	OPENAI_PROBE_RESPONSE,
	OPENAI_PROVIDER_ID,
} from "./acme-server.ts";
import { inspectProvider, type ProviderRuntimeOutput } from "./configured-runtime.ts";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const server = createAcmeServer("openai");

beforeAll(() => server.start());
beforeEach(() => server.reset());
afterAll(() => server.stop());

const expected: ProviderRuntimeOutput = {
	result: {
		validRequestReceived: true,
		model: {
			id: OPENAI_MODEL_ID,
			name: "Acme Chat",
			provider: OPENAI_PROVIDER_ID,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		},
		response: { text: OPENAI_PROBE_RESPONSE, stopReason: "stop", inputTokens: 3, outputTokens: 2 },
	},
};

const harness = createPiDocumentationEvalHarness({
	output: ({ session }) =>
		inspectProvider(session.modelRuntime, {
			providerId: OPENAI_PROVIDER_ID,
			modelId: OPENAI_MODEL_ID,
			createContext: () => ({
				messages: [{ role: "user", content: OPENAI_PROBE_PROMPT, timestamp: 0 }],
			}),
			options: { env: { ACME_API_KEY: "resolved-acme-key" }, maxTokens: 32 },
			validRequestReceived: server.validRequestReceived,
		}),
});
const judge = StructuredOutputJudge({ expected, match: "strict", allowExtras: false });

describeEval("Add OpenAI-compatible provider", { harness, judges: [judge], judgeThreshold: null }, (it) => {
	it("configures a provider that works through Pi", async ({ run }) => {
		await run([
			{
				type: "prompt",
				content: `Configure this running Pi installation with Acme as a provider. Do not create project-local configuration. Its provider ID is ${OPENAI_PROVIDER_ID}, its API is at ${server.baseUrl()}, and it uses OpenAI Chat Completions. Read its API key from the ACME_API_KEY environment variable.

The provider offers one model, ${OPENAI_MODEL_ID}, shown as “Acme Chat”. It accepts text, does not support reasoning, has a 32,768-token context window and a 4,096-token maximum output, and has no usage cost.`,
			},
			{ type: "reload" },
		]);
	});
});
