import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createAcmeServer,
	OPENAI_MODEL_ID,
	OPENAI_PROBE_PROMPT,
	OPENAI_PROBE_RESPONSE,
	OPENAI_PROVIDER_ID,
} from "../evals/acme-server.ts";
import { inspectAddedModel, inspectProvider, loadConfiguredModelRuntime } from "../evals/configured-runtime.ts";

const PROVIDER_ID = OPENAI_PROVIDER_ID;
const MODEL = {
	id: OPENAI_MODEL_ID,
	name: "Acme Chat",
	provider: PROVIDER_ID,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
};
const server = createAcmeServer("openai");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
beforeAll(() => server.start());
beforeEach(() => server.reset());
afterAll(() => server.stop());

async function agentDirWith(modelsJson: unknown) {
	const directory = await mkdtemp(join(tmpdir(), "pi-eval-provider-probe-"));
	temporaryDirectories.push(directory);
	await writeFile(join(directory, "models.json"), `${JSON.stringify(modelsJson)}\n`);
	return directory;
}

async function runtimeWith(modelsJson: unknown) {
	return loadConfiguredModelRuntime(await agentDirWith(modelsJson));
}

function acmeModelsJson() {
	return {
		providers: {
			[PROVIDER_ID]: {
				baseUrl: server.baseUrl(),
				api: "openai-completions",
				apiKey: "$ACME_API_KEY",
				models: [
					{
						id: MODEL.id,
						name: MODEL.name,
						reasoning: MODEL.reasoning,
						input: MODEL.input,
						cost: MODEL.cost,
						contextWindow: MODEL.contextWindow,
						maxTokens: MODEL.maxTokens,
					},
				],
			},
		},
	};
}

function probe(content: string, apiKey: string) {
	return {
		providerId: PROVIDER_ID,
		modelId: OPENAI_MODEL_ID,
		createContext: () => ({
			messages: [{ role: "user" as const, content, timestamp: 0 }],
		}),
		options: { env: { ACME_API_KEY: apiKey }, maxTokens: 32 },
		validRequestReceived: server.validRequestReceived,
	};
}

describe("inspectProvider", () => {
	it("probes a models.json provider through ModelRuntime", async () => {
		const runtime = await runtimeWith(acmeModelsJson());
		await expect(inspectProvider(runtime, probe(OPENAI_PROBE_PROMPT, "resolved-acme-key"))).resolves.toEqual({
			result: {
				validRequestReceived: true,
				model: MODEL,
				response: { text: OPENAI_PROBE_RESPONSE, stopReason: "stop", inputTokens: 3, outputTokens: 2 },
			},
		});
	});

	it("keeps a non-probe completion distinct from a valid probe", async () => {
		const runtime = await runtimeWith(acmeModelsJson());
		await expect(inspectProvider(runtime, probe("hello", "resolved-acme-key"))).resolves.toEqual({
			result: {
				validRequestReceived: false,
				model: MODEL,
				response: { text: OPENAI_PROBE_RESPONSE, stopReason: "stop", inputTokens: 3, outputTokens: 2 },
			},
		});
	});

	it("returns a structured error when the configured model is missing", async () => {
		const runtime = await runtimeWith({ providers: {} });
		await expect(inspectProvider(runtime, probe(OPENAI_PROBE_PROMPT, "resolved-acme-key"))).resolves.toEqual({
			result: { error: `Model ${PROVIDER_ID}/${OPENAI_MODEL_ID} is unavailable after reload.` },
		});
		expect(server.validRequestReceived()).toBe(false);
	});

	it("returns a structured error when models.json cannot be parsed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-eval-provider-probe-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, "models.json"), "{");
		const output = await inspectProvider(
			await loadConfiguredModelRuntime(directory),
			probe(OPENAI_PROBE_PROMPT, "resolved-acme-key"),
		);
		expect(output).toEqual({
			result: { error: expect.stringContaining("Failed to parse models.json") },
		});
		expect(server.validRequestReceived()).toBe(false);
	});

	it("does not treat an unauthorized completion as a valid probe", async () => {
		const runtime = await runtimeWith(acmeModelsJson());
		await expect(inspectProvider(runtime, probe(OPENAI_PROBE_PROMPT, "wrong-key"))).resolves.toEqual({
			result: {
				validRequestReceived: false,
				model: MODEL,
				response: { text: "", stopReason: "error", inputTokens: 0, outputTokens: 0 },
			},
		});
	});
});

describe("inspectAddedModel", () => {
	const PROVIDER = "openai";
	const MODEL_ID = "fixture-chat";
	const ADDED_MODEL = {
		id: MODEL_ID,
		name: "Fixture Chat",
		provider: PROVIDER,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};

	it("loads an added model without dropping built-in models", async () => {
		const directory = await agentDirWith({
			providers: {
				[PROVIDER]: {
					models: [
						{
							id: ADDED_MODEL.id,
							name: ADDED_MODEL.name,
							reasoning: ADDED_MODEL.reasoning,
							input: ADDED_MODEL.input,
							cost: ADDED_MODEL.cost,
							contextWindow: ADDED_MODEL.contextWindow,
							maxTokens: ADDED_MODEL.maxTokens,
						},
					],
				},
			},
		});
		await expect(inspectAddedModel(await loadConfiguredModelRuntime(directory), PROVIDER, MODEL_ID)).resolves.toEqual(
			{
				result: { model: ADDED_MODEL, existingModelsPreserved: true },
			},
		);
	});

	it("returns a structured error when the added model is missing", async () => {
		const directory = await agentDirWith({ providers: {} });
		await expect(inspectAddedModel(await loadConfiguredModelRuntime(directory), PROVIDER, MODEL_ID)).resolves.toEqual(
			{
				result: { error: `Model ${PROVIDER}/${MODEL_ID} is unavailable after reload.` },
			},
		);
	});

	it("returns a structured error when models.json cannot be parsed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-eval-provider-probe-"));
		temporaryDirectories.push(directory);
		await writeFile(join(directory, "models.json"), "{");
		await expect(inspectAddedModel(await loadConfiguredModelRuntime(directory), PROVIDER, MODEL_ID)).resolves.toEqual(
			{
				result: { error: expect.stringContaining("Failed to parse models.json") },
			},
		);
	});
});
