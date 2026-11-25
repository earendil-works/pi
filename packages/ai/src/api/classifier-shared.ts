import { calculateCost } from "../models.ts";
import type { ClassifierApi, ClassifierModel, ClassifierOptions, Usage } from "../types.ts";
import { isRecord, type JsonHttpError, postJsonRequest } from "./json-request.ts";

export { isRecord };

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
export type ClassifierHttpError = JsonHttpError;

export function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

/**
 * Posts one JSON classifier request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export function postClassifierRequest(
	label: string,
	url: URL,
	model: ClassifierModel<ClassifierApi>,
	body: unknown,
	options: ClassifierOptions | undefined,
	noRetryStatuses?: readonly number[],
): Promise<unknown> {
	return postJsonRequest(label, url, model, body, options, noRetryStatuses);
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
