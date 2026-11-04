// What pages and workers send the server's telemetry objects (decisions "Telemetry from browser pages", "The server is
// the one place telemetry is stored"): a batch of finished spans (a worker's with its metric aggregates), its schemas
// (a page's strict: every field bounded, ids printable ASCII, no control characters; a worker's, the server's own
// child, generous), and the two remote objects on the server that take them, `PageTelemetry` and `WorkerTelemetry`.

import type { AttributeValue, StoredMetric, StoredSpan } from "@earendil-works/pi-telemetry";
import { arr, hostKind, int, lit, method, num, obj, opt, remote, type Schema, str, union } from "../contracts/index.ts";

/** At most this many spans in a page's batch. */
export const PAGE_BATCH_SPANS = 100;

/** At most this many spans and metric rows in a worker's batch. */
export const WORKER_BATCH_ROWS = 1000;

/** An id: printable ASCII, no spaces (a page's are `browser:<incarnation>:<n>`). */
function id(max: number): Schema<string> {
	return str({ min: 1, max, pattern: "^[\\x21-\\x7e]+$" });
}

/** Text: no control characters (C0, DEL, C1), at most `max` characters. */
function text(max: number, min = 0): Schema<string> {
	return str({ min, max, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$" });
}

/** A record of attributes: at most `count` keys of 1 to 64 characters of text (other keys refused), values of `value`. */
function attributes(count: number, value: Schema): Schema<Record<string, AttributeValue>> {
	return {
		type: "object",
		maxProperties: count,
		patternProperties: { "^[^\\u0000-\\u001f\\u007f-\\u009f]{1,64}$": value },
		additionalProperties: false,
	};
}

/** A finished span as `span`'s fields allow: ids, a name, times, attributes, events, links and a status. */
function spanSchema(limits: SpanLimits): Schema<StoredSpan> {
	const record = attributes(limits.attributes, limits.value);
	const span = obj({
		id: id(limits.id),
		traceId: id(limits.id),
		parentId: opt(id(limits.id)),
		name: text(limits.name, 1),
		startedMs: num({ min: 0 }),
		endedMs: num({ min: 0 }),
		attributes: record,
		events: arr(obj({ name: text(limits.name, 1), timeMs: num({ min: 0 }), attributes: record }), {
			max: limits.events,
		}),
		links: arr(obj({ traceId: id(limits.id), spanId: id(limits.id), attributes: opt(record) }), {
			max: limits.links,
		}),
		status: union([
			obj({ status: lit("ok") }),
			obj({ status: lit("error"), error: opt(obj({ name: text(64), message: text(500) })) }),
		]),
	});
	// The object schema's static type is StoredSpan's shape: the same fields, optional ones `opt`.
	return span as unknown as Schema<StoredSpan>;
}

/** The bounds of one span's fields. */
type SpanLimits = {
	readonly id: number;
	readonly name: number;
	readonly attributes: number;
	readonly value: Schema;
	readonly events: number;
	readonly links: number;
};

/** A page's spans: what a recorded click needs, little more (decision "Telemetry from browser pages"). */
const PAGE_SPAN = spanSchema({
	id: 128,
	name: 128,
	attributes: 32,
	value: union([text(256), num(), { type: "boolean" } as Schema<boolean>]),
	events: 16,
	links: 8,
});

/** A worker's spans: bounded generously (its spans are Chord's and its plugins'). */
const WORKER_SPAN = spanSchema({
	id: 256,
	name: 1024,
	attributes: 256,
	value: union([str({ max: 65_536 }), num(), { type: "boolean" } as Schema<boolean>, arr(union([str(), num()]))]),
	events: 1024,
	links: 256,
});

/** A worker's metric row: one series' aggregate of one 10 s interval. */
const METRIC = obj({
	intervalMs: int({ min: 0 }),
	name: text(256, 1),
	kind: union([lit("counter"), lit("upDownCounter"), lit("histogram")]),
	unit: opt(text(64)),
	attributes: attributes(64, union([str({ max: 4096 }), num(), { type: "boolean" } as Schema<boolean>])),
	count: int({ min: 0 }),
	sum: num(),
	min: num(),
	max: num(),
}) as unknown as Schema<StoredMetric>;

/** What `ingest` answers: the spans the store queued and the ones it dropped (refused, over the rate, over its bound). */
const RECEIPT = obj({ written: int(), dropped: int() });

/** A page's batch (spans only: a page sends no metrics). */
export const PageBatch = obj({ spans: arr(PAGE_SPAN, { max: PAGE_BATCH_SPANS }) });

/** A worker's batch: its spans and its metric rows. */
export const WorkerBatch = obj({
	spans: arr(WORKER_SPAN, { max: WORKER_BATCH_ROWS }),
	metrics: arr(METRIC, { max: WORKER_BATCH_ROWS }),
});

/** The server's host kind as the app kit names it. */
const Server = hostKind("server");

/** The server's telemetry object for pages: any principal's page sends its batches to it, untrusted. */
export const PageTelemetry = remote("chord.telemetry.page", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { main: { methods: { ingest: method(PageBatch, RECEIPT) } } },
});

/**
 * The server's telemetry object for workers: `worker` for a worker's principal (its batches written as they are),
 * `other` for everyone else (nothing to call).
 */
export const WorkerTelemetry = remote("chord.telemetry.worker", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { methods: { ingest: method(WorkerBatch, RECEIPT) } }, other: {} },
});
