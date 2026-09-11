import { deepStrictEqual } from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type Api, type Context, contentText, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { createPiCodingAgentHarness, excludePiDocumentation, type PiCodingAgentInput } from "./pi-harness.ts";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const PROVIDER_ID = "acme";
const MODEL_ID = "acme-chat";
const PROBE_PROMPT = "Reply with ACME_OK.";
const PROBE_RESPONSE = "ACME_OK";
const CUSTOM_PROVIDER_ID = "acme-stream";
const CUSTOM_MODEL_ID = "acme-stream-chat";
const CUSTOM_PROBE_PROMPT = "Reply with ACME_STREAM_OK.";
const CUSTOM_PROBE_RESPONSE = "ACME_STREAM_OK";

let acmeServer: Server | undefined;
let acmeOrigin = "";
let acmeBaseUrl = "";
let validAcmeRequestReceived = false;
let validAcmeStreamRequestReceived = false;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectRequest(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, { "content-type": "text/plain" });
	response.end(message);
}

async function handleAcmeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method === "GET" && request.url === "/docs") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				name: "Acme Streaming API",
				request: {
					method: "POST",
					path: "/generate",
					headers: { "content-type": "application/json", "x-acme-key": "resolved credential" },
					body: {
						model: CUSTOM_MODEL_ID,
						messages: [{ role: "user", content: "Hello" }],
						stream: true,
					},
				},
				response: {
					contentType: "application/x-ndjson",
					events: [
						{ type: "text_delta", text: "Hello" },
						{ type: "usage", input_tokens: 3, output_tokens: 2 },
						{ type: "done", reason: "stop" },
					],
				},
			}),
		);
		return;
	}

	if (request.url !== "/generate" && request.url !== "/v1/chat/completions") {
		rejectRequest(response, 404, "Unknown endpoint");
		return;
	}
	if (request.method !== "POST") {
		rejectRequest(response, 405, "Expected POST");
		return;
	}
	if (!request.headers["content-type"]?.startsWith("application/json")) {
		rejectRequest(response, 415, "Expected application/json");
		return;
	}

	let body = "";
	for await (const chunk of request) body += chunk.toString();
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		rejectRequest(response, 400, "Invalid JSON");
		return;
	}
	if (!isRecord(payload)) {
		rejectRequest(response, 422, "Expected a JSON object");
		return;
	}
	const messages: unknown[] = Array.isArray(payload.messages) ? payload.messages : [];
	const userMessage = messages.find(
		(message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
	);
	const userPrompt = typeof userMessage?.content === "string" ? userMessage.content : null;

	if (request.url === "/generate") {
		if (request.headers["x-acme-key"] !== "resolved-stream-key") {
			rejectRequest(response, 401, "Invalid Acme Stream credential");
			return;
		}
		if (payload.model !== CUSTOM_MODEL_ID || userPrompt === null || payload.stream !== true) {
			rejectRequest(response, 422, "Invalid Acme Stream request");
			return;
		}
		validAcmeStreamRequestReceived = userPrompt === CUSTOM_PROBE_PROMPT;
		response.writeHead(200, { "content-type": "application/x-ndjson" });
		response.write(`${JSON.stringify({ type: "text_delta", text: "ACME_" })}\n`);
		response.write(`${JSON.stringify({ type: "text_delta", text: "STREAM_OK" })}\n`);
		response.write(`${JSON.stringify({ type: "usage", input_tokens: 4, output_tokens: 3 })}\n`);
		response.end(`${JSON.stringify({ type: "done", reason: "stop" })}\n`);
		return;
	}

	if (request.headers.authorization !== "Bearer resolved-acme-key") {
		rejectRequest(response, 401, "Invalid Acme credential");
		return;
	}
	if (payload.model !== MODEL_ID || userPrompt === null || payload.stream !== true) {
		rejectRequest(response, 422, "Invalid OpenAI-compatible request");
		return;
	}
	validAcmeRequestReceived = userPrompt === PROBE_PROMPT;
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-acme",
			object: "chat.completion.chunk",
			created: 0,
			model: MODEL_ID,
			choices: [{ index: 0, delta: { role: "assistant", content: PROBE_RESPONSE }, finish_reason: null }],
		})}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-acme",
			object: "chat.completion.chunk",
			created: 0,
			model: MODEL_ID,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 2 },
		})}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

beforeAll(async () => {
	acmeServer = createServer((request, response) => {
		void handleAcmeRequest(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		acmeServer!.once("error", reject);
		acmeServer!.listen(0, "127.0.0.1", resolve);
	});
	const address = acmeServer.address();
	if (!address || typeof address === "string") throw new Error("Fake Acme server did not bind a TCP port.");
	acmeOrigin = `http://127.0.0.1:${(address as AddressInfo).port}`;
	acmeBaseUrl = `${acmeOrigin}/v1`;
});

beforeEach(() => {
	validAcmeRequestReceived = false;
	validAcmeStreamRequestReceived = false;
});

afterAll(async () => {
	if (!acmeServer) return;
	await new Promise<void>((resolve, reject) => {
		acmeServer!.close((error) => (error ? reject(error) : resolve()));
	});
});

type ProviderRuntimeSuccess = {
	validRequestReceived: boolean;
	provider: { id: string; name: string };
	model: {
		id: string;
		name: string;
		provider: string;
		reasoning: boolean;
		input: Array<"text" | "image">;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
	};
	response: {
		text: string;
		stopReason: string;
		inputTokens: number;
		outputTokens: number;
	};
};

type ProviderRuntimeResult = ProviderRuntimeSuccess | { error: string };

type ProviderRuntimeOutput = {
	systemPromptHasGuidelines: boolean;
	systemPromptHasPiDocs: boolean;
	result: ProviderRuntimeResult;
};

type ProviderScenario = {
	providerId: string;
	modelId: string;
	createContext: () => Context;
	options?: ModelsSimpleStreamOptions;
	validRequestReceived: () => boolean;
};

type RuntimeResolver = (session: AgentSession, agentDir: string) => Promise<ModelRuntime>;

function summarizeModel(model: Model<Api>): ProviderRuntimeSuccess["model"] {
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

async function probeProvider(runtime: ModelRuntime, scenario: ProviderScenario): Promise<ProviderRuntimeSuccess> {
	const configurationError = runtime.getError();
	if (configurationError) throw new Error(configurationError);
	const provider = runtime.getProvider(scenario.providerId);
	const model = runtime.getModel(scenario.providerId, scenario.modelId);
	if (!provider || !model) {
		throw new Error(`Model ${scenario.providerId}/${scenario.modelId} is unavailable after reload.`);
	}
	const response = await runtime.completeSimple(model, scenario.createContext(), scenario.options);
	return {
		validRequestReceived: scenario.validRequestReceived(),
		provider: { id: provider.id, name: provider.name },
		model: summarizeModel(model),
		response: {
			text: contentText(response.content),
			stopReason: response.stopReason,
			inputTokens: response.usage.input,
			outputTokens: response.usage.output,
		},
	};
}

function createProviderHarness(
	name: string,
	scenario: ProviderScenario,
	transformSystemPrompt?: (defaultPrompt: string) => string,
	resolveRuntime: RuntimeResolver = async (session) => session.modelRuntime,
) {
	return createPiCodingAgentHarness({
		name,
		...(transformSystemPrompt ? { transformSystemPrompt } : {}),
		output: async ({ session, systemPrompt, agentDir }) => {
			let result: ProviderRuntimeResult;
			try {
				result = await probeProvider(await resolveRuntime(session, agentDir), scenario);
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

function createProviderRuntimeJudge(expected: ProviderRuntimeSuccess) {
	return createJudge<PiCodingAgentInput, ProviderRuntimeOutput>("ProviderRuntimeJudge", ({ output }) => {
		if ("error" in output.result) {
			return { score: 0, metadata: { rationale: output.result.error } };
		}
		try {
			deepStrictEqual(output.result, expected);
			return { score: 1, metadata: { rationale: "Provider works through Pi." } };
		} catch (error) {
			return { score: 0, metadata: { rationale: errorMessage(error) } };
		}
	});
}

const providerScenario: ProviderScenario = {
	providerId: PROVIDER_ID,
	modelId: MODEL_ID,
	createContext: () => ({ messages: [{ role: "user", content: PROBE_PROMPT, timestamp: Date.now() }] }),
	options: { env: { ACME_API_KEY: "resolved-acme-key" }, maxTokens: 32 },
	validRequestReceived: () => validAcmeRequestReceived,
};

const customProviderScenario: ProviderScenario = {
	providerId: CUSTOM_PROVIDER_ID,
	modelId: CUSTOM_MODEL_ID,
	createContext: () => ({ messages: [{ role: "user", content: CUSTOM_PROBE_PROMPT, timestamp: Date.now() }] }),
	options: { env: { ACME_STREAM_API_KEY: "resolved-stream-key" }, maxTokens: 32 },
	validRequestReceived: () => validAcmeStreamRequestReceived,
};

const ProviderAuthoringJudge = createProviderRuntimeJudge({
	validRequestReceived: true,
	provider: { id: PROVIDER_ID, name: "Acme" },
	model: {
		id: MODEL_ID,
		name: "Acme Chat",
		provider: PROVIDER_ID,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	},
	response: { text: PROBE_RESPONSE, stopReason: "stop", inputTokens: 3, outputTokens: 2 },
});

const CustomProviderJudge = createProviderRuntimeJudge({
	validRequestReceived: true,
	provider: { id: CUSTOM_PROVIDER_ID, name: "Acme Stream" },
	model: {
		id: CUSTOM_MODEL_ID,
		name: "Acme Stream Chat",
		provider: CUSTOM_PROVIDER_ID,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 2048,
	},
	response: { text: CUSTOM_PROBE_RESPONSE, stopReason: "stop", inputTokens: 4, outputTokens: 3 },
});

const resolveProviderRuntime: RuntimeResolver = async (session, agentDir) => {
	if (session.modelRuntime.getModel(PROVIDER_ID, MODEL_ID)) return session.modelRuntime;
	return ModelRuntime.create({
		modelsPath: join(agentDir, "models.json"),
		authPath: join(agentDir, "auth.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
};

const providerHarnessTable = evalHarnessTable("Add OpenAI-compatible provider", {
	baseline: createProviderHarness(
		"system-prompt-without-docs",
		providerScenario,
		excludePiDocumentation,
		resolveProviderRuntime,
	),
	candidate: createProviderHarness("default-system-prompt", providerScenario, undefined, resolveProviderRuntime),
});

describe.for(providerHarnessTable)("$name", ({ harness }) => {
	describeEval(
		"Add OpenAI-compatible provider",
		{ harness, judges: [ProviderAuthoringJudge], judgeThreshold: null },
		(it) => {
			it("adds the provider", { timeout: 300_000 }, async ({ run }) => {
				const result = await run([
					{
						type: "prompt",
						content: `Can you add Acme to Pi as a provider? Its provider ID is ${PROVIDER_ID}, its API is at ${acmeBaseUrl}, and it uses OpenAI Chat Completions. Read its API key from the ACME_API_KEY environment variable.

The provider offers one model, ${MODEL_ID}, shown as “Acme Chat”. It accepts text, does not support reasoning, has a 32,768-token context window and a 4,096-token maximum output, and has no usage cost.`,
					},
					{ type: "reload" },
				]);
				expect(result.output.systemPromptHasGuidelines).toBe(true);
				expect(result.output.systemPromptHasPiDocs).toBe(harness.name === "default-system-prompt");
			});
		},
	);
});

const customProviderHarnessTable = evalHarnessTable("Add custom streaming provider", {
	baseline: createProviderHarness("system-prompt-without-docs", customProviderScenario, excludePiDocumentation),
	candidate: createProviderHarness("default-system-prompt", customProviderScenario),
});

describe.for(customProviderHarnessTable)("$name", ({ harness }) => {
	describeEval(
		"Add custom streaming provider",
		{ harness, judges: [CustomProviderJudge], judgeThreshold: null },
		(it) => {
			it("adds the provider", { timeout: 300_000 }, async ({ run }) => {
				const result = await run([
					{
						type: "prompt",
						content: `Can you add Acme Stream to Pi as a provider? Its provider ID is ${CUSTOM_PROVIDER_ID}, its API is at ${acmeOrigin}, and its documentation is available at ${acmeOrigin}/docs. Read its credential from the ACME_STREAM_API_KEY environment variable.

It offers one model, ${CUSTOM_MODEL_ID}, shown as “Acme Stream Chat”. The model accepts text, does not support reasoning, has a 16,384-token context window and a 2,048-token maximum output, and has no usage cost.`,
					},
					{ type: "reload" },
				]);
				expect(result.output.systemPromptHasGuidelines).toBe(true);
				expect(result.output.systemPromptHasPiDocs).toBe(harness.name === "default-system-prompt");
			});
		},
	);
});
