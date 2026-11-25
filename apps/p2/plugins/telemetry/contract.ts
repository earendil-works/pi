// The owner's telemetry (docs/p2-notes.md, "Telemetry"): the server's store of traces and metrics, read through
// `Traces` (server) by the owner's pages (the Traces view and Settings) and by the agent of a session that is neither
// shared nor locked (the `telemetry` code-mode tools). Results are bounded: a page of traces, a trace's spans, metric
// rows.
import { arr, bool, int, nul, num, obj, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, method, record, remote, serverHost } from "@p2/app/v1";

/** The most traces one search returns. */
export const MAX_TRACES = 50;
/** The most spans of one trace returned (the earliest; `truncated` says when there were more). */
export const MAX_SPANS = 2000;
/** The most metric rows one search returns. */
export const MAX_METRICS = 1000;
/** What every read says while settings.json's `telemetry` is off (no store was opened at the server's start). */
export const TELEMETRY_OFF = "telemetry is off (settings.json telemetry)";
/** The most attributes one search filters by. */
export const MAX_FILTERS = 8;

/** An attribute's value, as spans record them. */
const AttributeValueSchema = union([str(), num(), bool(), arr(str()), arr(num()), arr(bool())]);
const AttributesSchema = record(AttributeValueSchema);
/** An attribute a search filters by (equality). */
const FilterValueSchema = union([str(), num(), bool()]);

/** A settled span as the store keeps it (pi-telemetry's `StoredSpan`): times in milliseconds, events relative. */
export const SpanSchema = obj({
	id: str(),
	traceId: str(),
	parentId: opt(str()),
	name: str(),
	startedMs: num(),
	endedMs: num(),
	attributes: AttributesSchema,
	events: arr(obj({ name: str(), timeMs: num(), attributes: AttributesSchema })),
	links: arr(obj({ traceId: str(), spanId: str(), attributes: opt(AttributesSchema) })),
	status: union([
		obj({ status: literal("ok") }),
		obj({ status: literal("error"), error: opt(obj({ name: str(), message: str() })) }),
	]),
});
export type Span = Static<typeof SpanSchema>;

/** A search of traces (pi-telemetry's `TraceQuery`): the first span's name, attributes one span has, errors, a window. */
export const TraceQuerySchema = obj({
	/** The name of the trace's earliest span. */
	name: opt(str({ minLength: 1, maxLength: 128 })),
	/** Equalities one span of the trace matches (at most `MAX_FILTERS`). */
	attributes: opt(record(FilterValueSchema)),
	/** Only traces with a failed span. */
	errors: opt(bool()),
	/** Bounds on the earliest span's start, wall-clock milliseconds. */
	startMin: opt(num()),
	startMax: opt(num()),
	limit: opt(int({ minimum: 1, maximum: MAX_TRACES })),
	/** The previous page's `cursor`, with the same filters. */
	cursor: opt(str({ maxLength: 1000 })),
});
export type TraceQuery = Static<typeof TraceQuerySchema>;

/** One trace found: its earliest span's name, its start and length, how many spans and failures, the hosts it spans. */
export const TraceSummarySchema = obj({
	traceId: str(),
	name: str(),
	startedMs: num(),
	durationMs: num(),
	spans: int(),
	errors: int(),
	hosts: arr(str()),
});
export type TraceSummary = Static<typeof TraceSummarySchema>;

/** A page of traces, newest first, and the cursor of the next page (absent: the last). */
export const FoundTracesSchema = obj({ traces: arr(TraceSummarySchema), cursor: opt(str()) });
export type FoundTraces = Static<typeof FoundTracesSchema>;

/** One trace: its spans by start (at most `MAX_SPANS`), and whether some were left out. */
export const TraceSchema = obj({ traceId: str(), spans: arr(SpanSchema), truncated: bool() });
export type Trace = Static<typeof TraceSchema>;

/** A search of metrics (pi-telemetry's `MetricQuery`): one metric, a window of its 10 s intervals, attributes. */
export const MetricQuerySchema = obj({
	name: str({ minLength: 1, maxLength: 128 }),
	startMin: opt(num()),
	startMax: opt(num()),
	attributes: opt(record(FilterValueSchema)),
});
export type MetricQuery = Static<typeof MetricQuerySchema>;

/** One series' aggregate over one 10 s interval. */
export const MetricSchema = obj({
	intervalMs: num(),
	name: str(),
	kind: oneOf(["counter", "upDownCounter", "histogram"] as const),
	unit: opt(str()),
	attributes: AttributesSchema,
	count: num(),
	sum: num(),
	min: num(),
	max: num(),
});
export type Metric = Static<typeof MetricSchema>;

/** Metric rows found (at most `MAX_METRICS`), and whether some were left out. */
export const FoundMetricsSchema = obj({ metrics: arr(MetricSchema), truncated: bool() });
export type FoundMetrics = Static<typeof FoundMetricsSchema>;

const READS = {
	findTraces: method(TraceQuerySchema, FoundTracesSchema),
	/** The trace, or null when the store has none of that ID (never recorded, or past the retention). */
	getTrace: method(obj({ traceId: str({ minLength: 1, maxLength: 256 }) }), union([TraceSchema, nul()])),
	findMetrics: method(MetricQuerySchema, FoundMetricsSchema),
};

/**
 * The telemetry store's reads (server). `owner`: the owner's pages. `agent`: a session's worker, for its agent's tools;
 * each call is refused (`forbidden`) while the session is shared (a link, a guest or a person: a guest reading the
 * transcript would read what the agent found) or locked. Anyone else is refused.
 */
export const Traces = remote("p2.traces", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: { owner: { methods: READS }, agent: { methods: READS } },
});
