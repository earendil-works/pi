import { afterAll, beforeAll, beforeEach } from "vitest";
import { describeEval, StructuredOutputJudge } from "vitest-evals";
import {
	createAcmeServer,
	STREAM_API_DOCUMENTATION,
	STREAM_MODEL_ID,
	STREAM_PROBE_PROMPT,
	STREAM_PROBE_RESPONSE,
	STREAM_PROVIDER_ID,
} from "./acme-server.ts";
import { inspectProvider, type ProviderRuntimeOutput } from "./configured-runtime.ts";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const DOCUMENTATION_PATH = "fixtures/acme-stream-api.json";
const STREAM_API_KEY = "resolved-stream-key";
const server = createAcmeServer("stream");

beforeAll(() => {
	process.env.ACME_STREAM_API_KEY = STREAM_API_KEY;
	return server.start();
});
beforeEach(() => server.reset());
afterAll(() => {
	delete process.env.ACME_STREAM_API_KEY;
	return server.stop();
});

const expected: ProviderRuntimeOutput = {
	result: {
		validRequestReceived: true,
		model: {
			id: STREAM_MODEL_ID,
			name: "Acme Stream Chat",
			provider: STREAM_PROVIDER_ID,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384,
			maxTokens: 2048,
		},
		response: { text: STREAM_PROBE_RESPONSE, stopReason: "stop", inputTokens: 4, outputTokens: 3 },
	},
};

const harness = createPiDocumentationEvalHarness({
	workspaceFiles: { [DOCUMENTATION_PATH]: STREAM_API_DOCUMENTATION },
	output: ({ session }) =>
		inspectProvider(session.modelRuntime, {
			providerId: STREAM_PROVIDER_ID,
			modelId: STREAM_MODEL_ID,
			createContext: () => ({
				messages: [{ role: "user", content: STREAM_PROBE_PROMPT, timestamp: 0 }],
			}),
			options: { env: { ACME_STREAM_API_KEY: STREAM_API_KEY }, maxTokens: 32 },
			validRequestReceived: server.validRequestReceived,
		}),
});
const judge = StructuredOutputJudge({ expected, match: "strict", allowExtras: false });

describeEval("Add custom streaming provider", { harness, judges: [judge], judgeThreshold: null }, (it) => {
	it("implements a provider from an API fixture", async ({ run }) => {
		await run([
			{
				type: "prompt",
				content: `Configure this running Pi installation with Acme Stream as a provider. Do not create a project package or modify project source. Its provider ID is ${STREAM_PROVIDER_ID}, its API is at ${server.origin()}, and its API documentation is in ./${DOCUMENTATION_PATH}. Read its credential from the ACME_STREAM_API_KEY environment variable.

It offers one model, ${STREAM_MODEL_ID}, shown as “Acme Stream Chat”. The model accepts text, does not support reasoning, has a 16,384-token context window and a 2,048-token maximum output, and has no usage cost.`,
			},
			{ type: "reload" },
		]);
	});
});
