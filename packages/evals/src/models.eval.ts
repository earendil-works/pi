import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, excludePiDocumentation, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const PROVIDER_ID = "openai";
const MODEL_ID = "fixture-chat";
const MODEL_NAME = "Fixture Chat";

type ModelSummary = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

type ModelAuthoringResult = { model: ModelSummary; existingModelsPreserved: boolean } | { error: string };

type ModelAuthoringOutput = {
	systemPromptHasGuidelines: boolean;
	systemPromptHasPiDocs: boolean;
	result: ModelAuthoringResult;
};

function summarizeModel(model: Model<Api>): ModelSummary {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createModelAuthoringHarness(name: string, transformSystemPrompt?: (defaultPrompt: string) => string) {
	return createPiCodingAgentHarness({
		name,
		...(transformSystemPrompt ? { transformSystemPrompt } : {}),
		output: async ({ session, systemPrompt, agentDir }) => {
			let result: ModelAuthoringResult;
			try {
				const pristineRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
				const existingModelIds =
					pristineRuntime
						.getProvider(PROVIDER_ID)
						?.getModels()
						.map(({ id }) => id) ?? [];
				let runtime = session.modelRuntime;
				if (!runtime.getModel(PROVIDER_ID, MODEL_ID)) {
					runtime = await ModelRuntime.create({
						modelsPath: join(agentDir, "models.json"),
						authPath: join(agentDir, "auth.json"),
						modelsStorePath: join(agentDir, "models-store.json"),
						allowModelNetwork: false,
					});
				}
				const configurationError = runtime.getError();
				if (configurationError) throw new Error(configurationError);
				const model = runtime.getModel(PROVIDER_ID, MODEL_ID);
				if (!model) throw new Error(`Model ${PROVIDER_ID}/${MODEL_ID} is unavailable after reload.`);
				result = {
					model: summarizeModel(model),
					existingModelsPreserved:
						existingModelIds.length > 0 &&
						existingModelIds.every((id) => runtime.getModel(PROVIDER_ID, id) !== undefined),
				};
			} catch (error) {
				result = { error: errorMessage(error) };
			}
			return {
				systemPromptHasGuidelines: systemPrompt.includes("\nGuidelines:\n"),
				systemPromptHasPiDocs: systemPrompt.includes("\nPi documentation (read only"),
				result,
			};
		},
	});
}

const expectedResult: Exclude<ModelAuthoringResult, { error: string }> = {
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
};

const ModelAuthoringJudge = createJudge<PiCodingAgentInput, ModelAuthoringOutput>(
	"ModelAuthoringJudge",
	({ output }) => {
		if ("error" in output.result) {
			return { score: 0, metadata: { rationale: output.result.error } };
		}
		try {
			deepStrictEqual(output.result, expectedResult);
			return { score: 1, metadata: { rationale: "Model was added to the existing provider." } };
		} catch (error) {
			return { score: 0, metadata: { rationale: errorMessage(error) } };
		}
	},
);

const modelHarnessTable = evalHarnessTable("Add model to existing provider", {
	baseline: createModelAuthoringHarness("system-prompt-without-docs", excludePiDocumentation),
	candidate: createModelAuthoringHarness("default-system-prompt"),
});

describe.for(modelHarnessTable)("$name", ({ harness }) => {
	describeEval(
		"Add model to existing provider",
		{ harness, judges: [ModelAuthoringJudge], judgeThreshold: null },
		(it) => {
			it("adds the model", { timeout: 300_000 }, async ({ run }) => {
				const result = await run([
					{
						type: "prompt",
						content: `Configure Pi with a new \`${PROVIDER_ID}/${MODEL_ID}\` model. Show it as “${MODEL_NAME}”. It accepts text, supports reasoning, has a 32,768-token context window and a 4,096-token maximum output, and has no usage cost.`,
					},
					{ type: "reload" },
				]);
				expect(result.output.systemPromptHasGuidelines).toBe(true);
				expect(result.output.systemPromptHasPiDocs).toBe(harness.name === "default-system-prompt");
			});
		},
	);
});
