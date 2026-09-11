import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import { describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, excludePiDocumentation, type PiCodingAgentInput } from "./pi-harness.ts";
import { recordEvalSourceArtifact } from "./vitest-evals/artifacts.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const PROVIDER_ID = "acme";
const MODEL_ID = "acme-chat";
const EXTENSION_NAME = "acme-provider.ts";

type ProviderAuthoringOutput = {
	systemPromptHasGuidelines: boolean;
	systemPromptHasPiDocs: boolean;
	extensionErrors: Array<{ path: string; error: string }>;
	extensionSource: string | null;
	registeredProvider: {
		name: string | null;
		baseUrl: string | null;
		apiKey: string | null;
		api: Api | null;
		modelIds: string[];
	} | null;
	provider: {
		id: string;
		name: string;
		baseUrl: string | null;
	} | null;
	model: {
		id: string;
		name: string;
		provider: string;
		api: Api;
		baseUrl: string;
		reasoning: boolean;
		input: Array<"text" | "image">;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	} | null;
};

function createProviderAuthoringHarness(name: string, transformSystemPrompt?: (defaultPrompt: string) => string) {
	return createPiCodingAgentHarness({
		name,
		...(transformSystemPrompt ? { transformSystemPrompt } : {}),
		output: ({ session, systemPrompt }) => {
			const extensionPath = join(session.sessionManager.getCwd(), ".pi", "extensions", EXTENSION_NAME);
			const registeredProvider = session.modelRuntime.getRegisteredProviderConfig(PROVIDER_ID);
			const provider = session.modelRuntime.getProvider(PROVIDER_ID);
			const model = session.modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
			return {
				systemPromptHasGuidelines: systemPrompt.includes("\nGuidelines:\n"),
				systemPromptHasPiDocs: systemPrompt.includes("\nPi documentation (read only"),
				extensionErrors: session.resourceLoader.getExtensions().errors,
				extensionSource: existsSync(extensionPath) ? readFileSync(extensionPath, "utf8") : null,
				registeredProvider: registeredProvider
					? {
							name: registeredProvider.name ?? null,
							baseUrl: registeredProvider.baseUrl ?? null,
							apiKey: registeredProvider.apiKey ?? null,
							api: registeredProvider.api ?? null,
							modelIds: registeredProvider.models?.map(({ id }) => id) ?? [],
						}
					: null,
				provider: provider ? { id: provider.id, name: provider.name, baseUrl: provider.baseUrl ?? null } : null,
				model: model
					? {
							id: model.id,
							name: model.name,
							provider: model.provider,
							api: model.api,
							baseUrl: model.baseUrl,
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
						}
					: null,
			};
		},
	});
}

const ProviderAuthoringJudge = createJudge<PiCodingAgentInput, ProviderAuthoringOutput>(
	"ProviderAuthoringJudge",
	({ output }) => {
		const failures: string[] = [];
		if (output.extensionSource === null) {
			failures.push("generated provider extension source is unavailable");
		} else {
			const imports = Array.from(
				output.extensionSource.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/g),
				(match) => match[1],
			);
			if (!imports.includes("@earendil-works/pi-coding-agent")) {
				failures.push("extension does not import the canonical @earendil-works/pi-coding-agent package");
			}
			if (imports.some((specifier) => specifier.startsWith("@mariozechner/"))) {
				failures.push("extension imports a legacy @mariozechner package");
			}
		}
		if (output.extensionErrors.length > 0) failures.push("extension loader reported errors");
		if (output.registeredProvider === null) {
			failures.push(`provider ${PROVIDER_ID} was not registered by the extension`);
		} else {
			if (output.registeredProvider.name !== "Acme") failures.push('provider name is not "Acme"');
			if (output.registeredProvider.baseUrl !== "https://api.acme.test/v1") {
				failures.push("provider base URL is incorrect");
			}
			if (output.registeredProvider.apiKey !== "$ACME_API_KEY") {
				failures.push("provider API key does not reference ACME_API_KEY");
			}
			if (output.registeredProvider.api !== "openai-completions") {
				failures.push("provider API is not openai-completions");
			}
			if (output.registeredProvider.modelIds.length !== 1 || output.registeredProvider.modelIds[0] !== MODEL_ID) {
				failures.push(`provider does not define exactly the ${MODEL_ID} model`);
			}
		}
		if (
			output.provider === null ||
			output.provider.id !== PROVIDER_ID ||
			output.provider.name !== "Acme" ||
			output.provider.baseUrl !== "https://api.acme.test/v1"
		) {
			failures.push("composed provider metadata is incorrect");
		}
		if (output.model === null) {
			failures.push(`model ${PROVIDER_ID}/${MODEL_ID} is unavailable after reload`);
		} else {
			if (output.model.id !== MODEL_ID || output.model.provider !== PROVIDER_ID) {
				failures.push("model identity is incorrect");
			}
			if (output.model.name !== "Acme Chat") failures.push('model name is not "Acme Chat"');
			if (output.model.api !== "openai-completions") failures.push("composed model API is incorrect");
			if (output.model.baseUrl !== "https://api.acme.test/v1") failures.push("composed model base URL is incorrect");
			if (output.model.reasoning) failures.push("model unexpectedly enables reasoning");
			if (output.model.input.length !== 1 || output.model.input[0] !== "text") {
				failures.push("model input must be text-only");
			}
			if (Object.values(output.model.cost).some((value) => value !== 0)) failures.push("model cost is not zero");
			if (output.model.contextWindow !== 32768) failures.push("model context window is incorrect");
			if (output.model.maxTokens !== 4096) failures.push("model max tokens is incorrect");
		}

		return {
			score: failures.length === 0 ? 1 : 0,
			metadata: {
				rationale: failures.length === 0 ? "Custom provider registered successfully." : failures.join("; "),
			},
		};
	},
);

const providerHarnessTable = evalHarnessTable("Pi custom provider authoring system prompt", {
	baseline: createProviderAuthoringHarness("system-prompt-without-docs", excludePiDocumentation),
	candidate: createProviderAuthoringHarness("default-system-prompt"),
});

describe.for(providerHarnessTable)("$name", ({ harness }) => {
	describeEval(
		"Pi custom provider authoring system prompt",
		{ harness, judges: [ProviderAuthoringJudge], judgeThreshold: null },
		(it) => {
			it("creates and registers a custom provider extension", async ({ run, task }) => {
				const result = await run([
					{
						type: "prompt",
						content: `Use only the current workspace and documentation paths explicitly listed in your system prompt. Do not search for other Pi installations or repositories.

Create a project-local Pi extension at .pi/extensions/${EXTENSION_NAME} that registers a custom provider with pi.registerProvider().

Provider requirements:
- ID: ${PROVIDER_ID}
- Display name: Acme
- Base URL: https://api.acme.test/v1
- API key: reference the ACME_API_KEY environment variable
- API: openai-completions

Register exactly one model:
- ID: ${MODEL_ID}
- Display name: Acme Chat
- Reasoning: disabled
- Input: text only
- All cost rates: 0
- Context window: 32768
- Maximum output tokens: 4096

Do not call the provider endpoint.`,
					},
					{ type: "reload" },
				]);
				if (result.output.extensionSource !== null) {
					const runId = result.artifacts?.runId;
					if (typeof runId !== "string") throw new Error("Pi eval run did not record a run ID.");
					await recordEvalSourceArtifact(task, runId, {
						name: EXTENSION_NAME,
						contentType: "text/typescript",
						body: result.output.extensionSource,
						bodyEncoding: "utf-8",
					});
				}
				expect(result.output.systemPromptHasGuidelines).toBe(true);
				expect(result.output.systemPromptHasPiDocs).toBe(harness.name === "default-system-prompt");
			});
		},
	);
});
