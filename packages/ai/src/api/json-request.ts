import { calculateCost } from "../models.ts";
import type { AnyModel, ProviderRequestOptions, Usage } from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { getIdentityHeaders } from "../utils/identity.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

/** An HTTP failure in the shape `retryProviderRequest` and `normalizeProviderError` understand. */
export interface JsonHttpError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
	body: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(label: string, response: Response, body: string): JsonHttpError {
	const error = new Error(`${label} returned ${response.status}`) as JsonHttpError;
	error.status = response.status;
	error.headers = response.headers;
	error.body = body;
	return error;
}

function timeoutError(timeoutMs: number): JsonHttpError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as JsonHttpError;
	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";
	return error;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Posts one JSON provider request with bearer auth, `onPayload`/`onResponse` hooks, a fresh
 * timeout per attempt, and provider retries. Returns the parsed response body; throws on failure.
 * `noRetryStatuses` lists HTTP statuses that fail at once although they are normally retried.
 */
export async function postJsonRequest<TModel extends AnyModel>(
	label: string,
	url: URL,
	model: TModel,
	body: unknown,
	options: ProviderRequestOptions<TModel> | undefined,
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
					headers:
						providerHeadersToRecord(
							getIdentityHeaders(model, options.identity),
							{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
							model.headers,
							options.headers,
						) ?? {},
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

/**
 * Parses a canonical pi `Usage` object returned by `pi-decision` / `pi-image` backends.
 * Trusts a provider-reported `cost.total` when present; otherwise computes cost from the model catalog.
 */
export function parsePiUsage(value: unknown, model: AnyModel): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const hasTokens = typeof value.input === "number" || typeof value.output === "number";
	const rawCost = isRecord(value.cost) ? value.cost : undefined;
	const hasProviderCost = rawCost !== undefined && typeof rawCost.total === "number" && Number.isFinite(rawCost.total);
	if (!hasTokens && !hasProviderCost) return undefined;
	const input = finiteNonNegative(value.input);
	const output = finiteNonNegative(value.output);
	const cacheRead = finiteNonNegative(value.cacheRead);
	const cacheWrite = finiteNonNegative(value.cacheWrite);
	const totalTokens =
		typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens) && value.totalTokens >= 0
			? value.totalTokens
			: input + output + cacheRead + cacheWrite;
	const usage: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		// Optional splits stay undefined when the backend does not report them.
		...(typeof value.reasoning === "number" && Number.isFinite(value.reasoning) && value.reasoning >= 0
			? { reasoning: value.reasoning }
			: {}),
		...(typeof value.imageOutput === "number" && Number.isFinite(value.imageOutput) && value.imageOutput >= 0
			? { imageOutput: value.imageOutput }
			: {}),
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	if (hasProviderCost) {
		usage.cost = {
			input: finiteNonNegative(rawCost.input),
			output: finiteNonNegative(rawCost.output),
			cacheRead: finiteNonNegative(rawCost.cacheRead),
			cacheWrite: finiteNonNegative(rawCost.cacheWrite),
			total: finiteNonNegative(rawCost.total),
			...(typeof rawCost.totalFromProvider === "boolean" ? { totalFromProvider: rawCost.totalFromProvider } : {}),
		};
	} else {
		calculateCost(model, usage);
	}
	return usage;
}
