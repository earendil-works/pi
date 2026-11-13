// The agent's telemetry tools, for code mode only (namespace `telemetry`): find traces, read one (as text and as its
// spans), find metrics, in the owner's telemetry store on the server (`Traces`, its `agent` variant). Never in a locked
// session (`locked: "never"`); the server refuses them while the session is shared or locked, at every call. Deferred:
// the code-mode section lists the namespace only, `describeNamespace("telemetry")` gives the declarations.
import { defineExtension, type ToolNamespace } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { Context, JsonValue } from "@p2/app/v1";
import { defineP2Tool, type P2Tool, renderTrace } from "@p2/app/v1/worker";
import {
	type FoundMetrics,
	FoundMetricsSchema,
	type FoundTraces,
	FoundTracesSchema,
	type MetricQuery,
	MetricQuerySchema,
	type Trace,
	type TraceQuery,
	TraceQuerySchema,
	TraceSchema,
} from "./contract.ts";

/** What the tools reach: `Traces` on the server, as the session's worker. */
export type TelemetryBackend = {
	findTraces(query: TraceQuery, context: Context): Promise<FoundTraces>;
	getTrace(traceId: string, context: Context): Promise<Trace | null>;
	findMetrics(query: MetricQuery, context: Context): Promise<FoundMetrics>;
};

/** The namespace of the telemetry tools in code mode. */
export const TELEMETRY_NAMESPACE: ToolNamespace = {
	name: "telemetry",
	description:
		'The owner\'s traces and metrics: telemetry_find_traces, telemetry_get_trace, telemetry_find_metrics (describeNamespace("telemetry") gives their declarations).',
	instructions: [
		"Traces are what p2 recorded (Chord's calls, holds, methods, relays, activations; Durable's submits and phases; model requests), kept 7 days. Times are wall-clock milliseconds.",
		"telemetry_find_traces searches by the earliest span's name, attributes one span has (chord.host: `server`, `session|<id>`, `browser`; p2.principal; type; member), errors and a time window, newest first; page with cursor. telemetry_get_trace gives one trace as a tree (text) and its spans. telemetry_find_metrics gives a metric's 10 s aggregates.",
		"Only in sessions shared with nobody and not locked: elsewhere the tools are refused.",
	].join("\n"),
};

/** A tool of the set: code mode only, deferred, read-only, its outcome a structured value and its text. */
function telemetryTool<A extends object>(tool: {
	name: string;
	description: string;
	parameters: object;
	output: object;
	run: (args: A, context: Context) => Promise<{ value: JsonValue; text: string }>;
}): P2Tool {
	return defineP2Tool<A>({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as never,
		structuredOutputSchema: tool.output as never,
		callers: ["tools"],
		// Listed by namespace only: the code-mode section's token budget is for the tools the agent uses all the time
		// (three typed tools here took the `agent` tool's place); scripts call deferred tools as any other.
		deferred: true,
		replay: "safe",
		locked: "never",
		execute: async (args, _api, context) => {
			try {
				const { value, text } = await tool.run(args as A, context);
				return { output: [{ type: "text" as const, text }], structuredOutput: value, details: {} };
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				const text = error instanceof Error ? error.message : String(error);
				return { output: [{ type: "text" as const, text }], isError: true };
			}
		},
	});
}

/** Milliseconds as the lists show them. */
const ms = (value: number): string => `${value.toFixed(value < 10 ? 2 : 0)} ms`;

/** The telemetry tools, reaching the server through `backend`. */
export function createTelemetryExtension(backend: TelemetryBackend) {
	return defineExtension<P2Tool>({
		name: "p2-telemetry",
		namespace: TELEMETRY_NAMESPACE,
		tools: [
			telemetryTool<TraceQuery>({
				name: "telemetry_find_traces",
				description:
					"Traces in the owner's telemetry store, newest first: traceId, the earliest span's name, start (ms since epoch), duration, span and error counts, hosts. Filters: name (the earliest span's), attributes (equalities one span matches, at most 8), errors, startMin/startMax (ms), limit (at most 50), cursor (the previous page's).",
				parameters: TraceQuerySchema,
				output: FoundTracesSchema,
				run: async (query, context) => {
					const found = await backend.findTraces(query, context);
					const lines = found.traces.map(
						(trace) =>
							`${trace.traceId}  ${new Date(trace.startedMs).toISOString()}  ${ms(trace.durationMs)}  ${trace.name}  ${trace.spans} spans${trace.errors ? `, ${trace.errors} failed` : ""}  [${trace.hosts.join(", ")}]`,
					);
					const more = found.cursor === undefined ? "" : "\nMore: pass cursor for the next page.";
					return { value: found, text: (lines.join("\n") || "No traces.") + more };
				},
			}),
			telemetryTool<{ traceId: string }>({
				name: "telemetry_get_trace",
				description:
					"One trace: as text (a tree of spans with their lengths, attributes, events and links) and its spans (at most 2000, by start; truncated says when there were more). found is false for an unknown or expired trace.",
				parameters: obj({ traceId: str({ minLength: 1, maxLength: 256 }) }),
				output: obj({ found: bool(), text: str(), trace: opt(TraceSchema) }),
				run: async ({ traceId }, context): Promise<{ value: JsonValue; text: string }> => {
					const trace = await backend.getTrace(traceId, context);
					if (trace === null) {
						const text = `No trace ${traceId} (never recorded, or older than the retention).`;
						return { value: { found: false, text }, text };
					}
					const note = trace.truncated ? "\n(Only the first 2000 spans.)" : "";
					const text = renderTrace(trace.spans) + note;
					return { value: { found: true, text, trace }, text };
				},
			}),
			telemetryTool<MetricQuery>({
				name: "telemetry_find_metrics",
				description:
					"A metric's 10 s aggregates (count, sum, min, max per series and interval), e.g. chord.link.bytes, pi.ai.request.duration. Filters: startMin/startMax (ms), attributes (equalities). At most 1000 rows.",
				parameters: MetricQuerySchema,
				output: FoundMetricsSchema,
				run: async (query, context) => {
					const found = await backend.findMetrics(query, context);
					const lines = found.metrics.map(
						(metric) =>
							`${new Date(metric.intervalMs).toISOString()}  ${JSON.stringify(metric.attributes)}  count ${metric.count}  sum ${metric.sum}  min ${metric.min}  max ${metric.max}`,
					);
					const note = found.truncated ? "\n(Only the first 1000 rows.)" : "";
					return { value: found, text: (lines.join("\n") || "No rows.") + note };
				},
			}),
		],
	});
}
