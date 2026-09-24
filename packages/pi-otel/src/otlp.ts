import { randomBytes } from "node:crypto";
import type { AttributeValue, RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";

/** OTLP/JSON `AnyValue`. Exactly one key is set per value. */
export interface OtlpAnyValue {
	stringValue?: string;
	intValue?: string;
	doubleValue?: number;
	boolValue?: boolean;
	arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyvalue {
	key: string;
	value: OtlpAnyValue;
}

export interface OtlpSpanEvent {
	name: string;
	timeUnixNano: string;
	attributes: OtlpKeyvalue[];
}

/** OTLP status codes: 0 unset, 1 ok, 2 error. */
export interface OtlpSpanStatus {
	code: 0 | 1 | 2;
	message?: string;
}

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpKeyvalue[];
	events: OtlpSpanEvent[];
	status: OtlpSpanStatus;
}

/** Minimal OTLP/JSON export request: one resource, one instrumentation scope. */
export interface OtlpTraceRequest {
	resourceSpans: [
		{
			resource: { attributes: OtlpKeyvalue[] };
			scopeSpans: [{ scope: { name: string }; spans: OtlpSpan[] }];
		},
	];
}

/**
 * Returns a random W3C-conformant hex identifier: 32 lowercase hex chars for
 * 16-byte trace ids, 16 for 8-byte span ids. All-zero ids are invalid per W3C
 * Trace Context and are regenerated.
 */
export function randomId(size: 8 | 16): string {
	for (;;) {
		const candidate = randomBytes(size).toString("hex");
		if (!/^0+$/.test(candidate)) return candidate;
	}
}

export function toOtlpAnyValue(value: AttributeValue): OtlpAnyValue {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
	return { arrayValue: { values: value.map(toOtlpAnyValue) } };
}

export function toOtlpKeyvalues(attributes: Record<string, AttributeValue | undefined>): OtlpKeyvalue[] {
	const keyvalues: OtlpKeyvalue[] = [];
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		keyvalues.push({ key, value: toOtlpAnyValue(value) });
	}
	return keyvalues;
}

export interface RecordedSpanTimes {
	startNs: bigint;
	endNs?: bigint;
}

/**
 * Converts a recorded span to the OTLP/JSON wire shape.
 *
 * Timestamps follow the telemetry contract, which records settlement order but
 * not settlement times: the span's end time is the export observation time
 * (or the observed settlement time, when supplied), so end times are precise
 * to the flush cycle, never earlier than the span actually finished.
 */
export function convertRecordedSpan(
	span: RecordedTelemetrySpan,
	ids: { traceId: string; spanId: string },
	parentSpanId: string | undefined,
	times: RecordedSpanTimes,
): OtlpSpan {
	const endNs = times.endNs ?? times.startNs;
	const events = span.events.map(
		(event): OtlpSpanEvent => ({
			name: event.name,
			timeUnixNano: endNs.toString(),
			attributes: toOtlpKeyvalues(event.attributes),
		}),
	);
	const status: OtlpSpanStatus =
		span.status.status === "error" ? { code: 2, message: span.status.error?.message ?? "error" } : { code: 0 };
	return {
		traceId: ids.traceId,
		spanId: ids.spanId,
		...(parentSpanId ? { parentSpanId } : {}),
		name: span.name,
		startTimeUnixNano: times.startNs.toString(),
		endTimeUnixNano: endNs.toString(),
		attributes: toOtlpKeyvalues(span.attributes),
		events,
		status,
	};
}
