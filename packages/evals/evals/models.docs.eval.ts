import { describeEval, StructuredOutputJudge } from "vitest-evals";
import { inspectAddedModel, type AddedModelOutput } from "./configured-runtime.ts";
import { createPiDocumentationEvalHarness } from "../src/harness.ts";

const PROVIDER_ID = "openai";
const MODEL_ID = "fixture-chat";
const MODEL_NAME = "Fixture Chat";

const expected: AddedModelOutput = {
	result: {
		model: {
			id: MODEL_ID,
			name: MODEL_NAME,
			provider: PROVIDER_ID,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		},
		existingModelsPreserved: true,
	},
};

const harness = createPiDocumentationEvalHarness({
	output: ({ session }) => inspectAddedModel(session.modelRuntime, PROVIDER_ID, MODEL_ID),
});
const judge = StructuredOutputJudge({ expected, match: "strict", allowExtras: false });

describeEval("Add model to existing provider", { harness, judges: [judge], judgeThreshold: null }, (it) => {
	it("adds the model without replacing existing models", async ({ run }) => {
		await run([
			{
				type: "prompt",
				content: `Configure this running Pi installation with a new \`${PROVIDER_ID}/${MODEL_ID}\` model. Do not create project-local configuration. Show it as “${MODEL_NAME}”. It accepts text, supports reasoning, has a 32,768-token context window and a 4,096-token maximum output, and has no usage cost.`,
			},
			{ type: "reload" },
		]);
	});
});
