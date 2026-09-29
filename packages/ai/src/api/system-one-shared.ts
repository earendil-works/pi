import { calculateCost } from "../models.ts";
import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

/** TypeSafe System One request body without the transport-specific envelope. */
export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
}

/** Differences between services that serve System One models. */
export interface SystemOneTransport {
	/** Classifier API implemented by this transport. */
	api: ClassifierApi;
	/** Service name used in error messages. */
	label: string;
	/** Absolute request URL. */
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** Wraps the System One request in the service's request envelope. */
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** Extracts the System One output (`{ answers, usage }`) from the service's response envelope. */
	output(body: unknown): Record<string, unknown>;
}

interface SystemOneHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(label: string, response: Response, body: string): SystemOneHttpError {
	const error = new Error(`${label} returned ${response.status}`) as SystemOneHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): SystemOneHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as SystemOneHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: probabilities(label, answer.probabilities, id),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers.push([
				id,
				{
					type: "score",
					score: requiredNumber(label, answer.score, `score for ${id}`),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: requiredNumber(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from System One's `{ input_tokens, output_tokens }`, priced from the model catalog like chat
 * usage. A missing or malformed usage object leaves the result without usage instead of failing it.
 */
function parseUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
function wireRequest(context: ClassifierContext): SystemOneWireRequest {
	return {
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

/** Runs one System One classification over the given transport. */
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const apiKey = options.apiKey;
		let payload = transport.payload(model, wireRequest(context));
		const transformed = await options.onPayload?.(payload, model);
		if (transformed !== undefined) payload = transformed;
		const requestFetch = options.fetch ?? globalThis.fetch;
		const { response, body } = await retryProviderRequest(
			async () => {
				const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
				const signal =
					options.signal && timeoutSignal
						? AbortSignal.any([options.signal, timeoutSignal])
						: (options.signal ?? timeoutSignal);
				try {
					const next = await requestFetch(transport.url(model), {
						method: "POST",
						headers: requestHeaders(model, apiKey, options.headers),
						body: JSON.stringify(payload),
						signal,
					});
					if (!next.ok) throw httpError(transport.label, next, await next.text());
					return { response: next, body: (await next.json()) as unknown };
				} catch (error) {
					if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
					throw error;
				}
			},
			{
				maxRetries: options.maxRetries ?? 2,
				maxRetryDelayMs: options.maxRetryDelayMs,
				signal: options.signal,
			},
		);
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
		const result = transport.output(body);
		// Set before parsing answers: a request with malformed answers was still billed.
		const usage = parseUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
