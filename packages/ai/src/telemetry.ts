import {
	createTypedMetrics,
	createTypedSpanStarter,
	defineTelemetrySchema,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SchemaTelemetrySpan,
	type TelemetryMetrics,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { LazyStreamObserver } from "./api/lazy.ts";
import type { Api, Model } from "./types.ts";
import { ownedSlice } from "./utils/text.ts";

const provider = { type: "string", description: "Provider identifier.", required: true } as const;
const model = { type: "string", description: "Requested model identifier.", required: true } as const;
const stop = {
	type: "string",
	description: "Normalized stop reason.",
	values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
} as const;
const request = {
	description: "One logical model request, including authentication and provider setup.",
	parents: { kind: "any" },
	startAttributes: {
		provider,
		api: { type: "string", description: "API identifier.", required: true },
		model,
		reasoning: { type: "string", description: "Scalar requested reasoning level.", required: false },
	},
	endAttributes: {
		stop,
		"usage.input": { type: "number", description: "Uncached input tokens." },
		"usage.output": { type: "number", description: "Output tokens." },
		"usage.cache_read": { type: "number", description: "Cache-read tokens." },
		"usage.cache_write": { type: "number", description: "Cache-write tokens." },
		"cost.total": { type: "number", description: "Total request cost in USD." },
		"response.id": { type: "string", description: "Provider response identifier.", cardinality: "high" },
	},
	events: {
		"pi.ai.first_chunk": { description: "First normalized stream event delivered.", attributes: {} },
		"pi.ai.block": {
			description: "A completed content block; content is never recorded.",
			attributes: {
				type: {
					type: "string",
					description: "Block kind.",
					values: ["text", "thinking", "tool_call"],
					required: true,
				},
				index: { type: "number", description: "Content block index.", required: true },
				chars: { type: "number", description: "UTF-16 character count.", required: true },
				tool: { type: "string", description: "Tool name, for tool-call blocks only.", required: false },
			},
		},
	},
	status: {
		default: "ok",
		errorWhen: "Stop reason is error: provider_error with at most 500 error-message characters. Aborted stays ok.",
	},
} as const;

/** Pi-owned request metadata, bounded error status, events, and low-cardinality metrics. */
export const AI_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"pi.ai.request": request,
		"pi.ai.poll": { ...request, description: "One deferred-response poll, not the deferred request's lifetime." },
	},
	metrics: {
		"pi.ai.request.duration": {
			kind: "histogram",
			description: "Logical request or poll duration.",
			unit: "ms",
			attributes: { provider, model, stop: { ...stop, required: true } },
		},
		"pi.ai.first_chunk.duration": {
			kind: "histogram",
			description: "Time to the first normalized stream event.",
			unit: "ms",
			attributes: { provider, model },
		},
		"pi.ai.tokens": {
			kind: "counter",
			description: "Reported model token usage; pending and deferred polls are excluded.",
			unit: "token",
			attributes: {
				provider,
				model,
				kind: {
					type: "string",
					description: "Token usage category.",
					values: ["input", "output", "cache_read", "cache_write"],
					required: true,
				},
			},
		},
		"pi.ai.cost": {
			kind: "counter",
			description: "Reported model cost; pending and deferred polls are excluded.",
			unit: "USD",
			attributes: { provider, model },
		},
	},
});

type RequestSpan = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, "pi.ai.request">;

function createInstruments(adapter: TelemetryMetrics) {
	const metrics = createTypedMetrics(adapter, [AI_TELEMETRY_SCHEMA]);
	return {
		requestDuration: metrics.histogram("pi.ai.request.duration"),
		firstChunkDuration: metrics.histogram("pi.ai.first_chunk.duration"),
		tokens: metrics.counter("pi.ai.tokens"),
		cost: metrics.counter("pi.ai.cost"),
	};
}

const instrumentCache = new WeakMap<TelemetryMetrics, ReturnType<typeof createInstruments>>();

export function observeModelRequest(
	requestedModel: Model<Api>,
	options: { telemetry?: TelemetrySpan; reasoning?: unknown } | undefined,
	poll: boolean,
): LazyStreamObserver {
	const started = performance.now();
	const attributes = { provider: requestedModel.provider, model: requestedModel.id };
	const adapter = options?.telemetry?.metrics ?? NOOP_TELEMETRY_METRICS;
	let instruments = instrumentCache.get(adapter);
	if (!instruments) {
		instruments = createInstruments(adapter);
		instrumentCache.set(adapter, instruments);
	}
	const { requestDuration, firstChunkDuration, tokens, cost } = instruments;
	let span!: RequestSpan;
	let finish!: () => void;
	let first = true;
	const toolChars = new Map<number, number>();
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const run = (activeSpan: RequestSpan): Promise<void> => {
		span = activeSpan;
		return finished;
	};
	const startAttributes = {
		...attributes,
		api: requestedModel.api,
		...(typeof options?.reasoning === "string" ? { reasoning: options.reasoning } : {}),
	};
	const start = createTypedSpanStarter(options?.telemetry ?? NOOP_TELEMETRY_CONTEXT, [AI_TELEMETRY_SCHEMA]);
	if (poll) void start("pi.ai.poll", startAttributes, run);
	else void start("pi.ai.request", startAttributes, run);

	return {
		onEvent(event) {
			if (first) {
				first = false;
				span.addEvent("pi.ai.first_chunk");
				firstChunkDuration.record(performance.now() - started, attributes, span);
			}
			if (event.type === "toolcall_delta") {
				toolChars.set(event.contentIndex, (toolChars.get(event.contentIndex) ?? 0) + event.delta.length);
			} else if (event.type === "text_end" || event.type === "thinking_end") {
				span.addEvent("pi.ai.block", {
					type: event.type === "text_end" ? "text" : "thinking",
					index: event.contentIndex,
					chars: event.content.length,
				});
			} else if (event.type === "toolcall_end") {
				const chars = toolChars.get(event.contentIndex) ?? 0;
				toolChars.delete(event.contentIndex);
				span.addEvent("pi.ai.block", {
					type: "tool_call",
					index: event.contentIndex,
					chars,
					tool: event.toolCall.name,
				});
			}
		},
		onResult(message) {
			if (message) {
				span.setAttributes({
					stop: message.stopReason,
					"usage.input": message.usage.input,
					"usage.output": message.usage.output,
					"usage.cache_read": message.usage.cacheRead,
					"usage.cache_write": message.usage.cacheWrite,
					"cost.total": message.usage.cost.total,
					"response.id": message.responseId,
				});
				if (message.stopReason === "error") {
					span.setStatus({
						status: "error",
						error: { name: "provider_error", message: ownedSlice(message.errorMessage ?? "", 0, 500) },
					});
				}
				requestDuration.record(performance.now() - started, { ...attributes, stop: message.stopReason }, span);
				if (!poll || (message.stopReason !== "pending" && message.stopReason !== "deferred")) {
					tokens.add(message.usage.input, { ...attributes, kind: "input" });
					tokens.add(message.usage.output, { ...attributes, kind: "output" });
					tokens.add(message.usage.cacheRead, { ...attributes, kind: "cache_read" });
					tokens.add(message.usage.cacheWrite, { ...attributes, kind: "cache_write" });
					cost.add(message.usage.cost.total, attributes);
				}
			}
			finish();
		},
	};
}
