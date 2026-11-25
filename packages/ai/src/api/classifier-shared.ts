import { calculateCost } from "../models.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, ProviderHeaders, Usage } from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
export interface ClassifierHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

function httpError(label: string, response: Response, body: string): ClassifierHttpError {
	const error = new Error(`${label} returned ${response.status}`) as ClassifierHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): ClassifierHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as ClassifierHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
): Record<string, string> {
	return (
		providerHeadersToRecord(
			getIdentityHeaders(model, identity),
			{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			model.headers,
			optionsHeaders,
		) ?? {}
	);
}

/**
 * Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export async function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
): Promise<unknown> {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const apiKey = options.apiKey;
	let payload = body;
	const transformed = await options.onPayload?.(payload, model);
	if (transformed !== undefined) payload = transformed;
	const requestFetch = options.fetch ?? globalThis.fetch;
	return retryProviderRequest(
		async () => {
			const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
			const signal =
				options.signal && timeoutSignal
					? AbortSignal.any([options.signal, timeoutSignal])
					: (options.signal ?? timeoutSignal);
			try {
				const next = await requestFetch(url, {
					method: "POST",
					headers: requestHeaders(model, apiKey, options.headers, options.identity),
					body: JSON.stringify(payload),
					signal,
				});
				// Reported before the body is read, so a body that fails to arrive still reports its status.
				await options.onResponse?.({ status: next.status, headers: headersToRecord(next.headers) }, model);
				if (!next.ok) throw httpError(label, next, await next.text());
				return (await next.json()) as unknown;
			} catch (error) {
				if (timeoutSignal?.aborted && !options.signal?.aborted) throw timeoutError(options.timeoutMs!);
				throw error;
			}
		},
		{
			maxRetries: options.maxRetries ?? 2,
			maxRetryDelayMs: options.maxRetryDelayMs,
			signal: options.signal,
			noRetryStatuses,
		},
	);
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Usage from a `{ input_tokens, output_tokens }` object, priced from the model catalog like chat
 * usage. A missing or malformed usage object leaves the result without usage instead of failing it.
 * `input_tokens_details.cached_tokens` and `cache_write_tokens` are included in `input_tokens`, as
 * in the Responses API, so they are split out of `input`.
 */
export function parseClassifierUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const totalInput = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const cacheRead = Math.min(tokenCount(details?.cached_tokens), totalInput);
	const cacheWrite = Math.min(tokenCount(details?.cache_write_tokens), totalInput - cacheRead);
	const usage: Usage = {
		input: totalInput - cacheRead - cacheWrite,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: totalInput + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}
