import type { Api, Model, RawProviderPayload, StreamOptions } from "../types.ts";

interface RawProviderMeta {
	requestId?: string;
	status?: number;
	headers?: Record<string, string>;
}

export function getProviderRequestId(headers: Record<string, string> | undefined): string | undefined {
	if (!headers) return undefined;
	return headers["x-request-id"] ?? headers["request-id"] ?? headers["x-openai-request-id"];
}

function buildRawProviderPayload<TApi extends Api>(
	model: Model<TApi>,
	meta: RawProviderMeta,
	index: number,
	raw: unknown,
): RawProviderPayload {
	return {
		provider: model.provider,
		api: model.api,
		model: model.id,
		requestId: meta.requestId,
		status: meta.status,
		headers: meta.headers,
		index,
		raw,
		timestamp: Date.now(),
	};
}

export async function emitRawRequestBody<TApi extends Api>(
	options: StreamOptions | undefined,
	model: Model<TApi>,
	raw: unknown,
): Promise<void> {
	await options?.onRawRequestBody?.(buildRawProviderPayload(model, {}, 0, raw), model);
}

export async function emitRawResponseChunk<TApi extends Api>(
	options: StreamOptions | undefined,
	model: Model<TApi>,
	meta: RawProviderMeta,
	index: number,
	raw: unknown,
): Promise<void> {
	await options?.onRawResponseChunk?.(buildRawProviderPayload(model, meta, index, raw), model);
}

export async function emitRawResponseEnd<TApi extends Api>(
	options: StreamOptions | undefined,
	model: Model<TApi>,
	meta: RawProviderMeta,
	index: number,
	raw: unknown = { done: true },
): Promise<void> {
	await options?.onRawResponseEnd?.(buildRawProviderPayload(model, meta, index, raw), model);
}

export function createRawProviderErrorEnvelope(error: unknown): {
	error: { name?: string; message: string; stack?: string };
} {
	if (error instanceof Error) {
		return { error: { name: error.name, message: error.message, stack: error.stack } };
	}
	return { error: { message: String(error) } };
}
