import type { SpanOptions, TelemetryPropagation, TelemetrySpan } from "./index.ts";
import type { TelemetryCounter, TelemetryHistogram, TelemetryMetrics, TelemetryUpDownCounter } from "./metrics.ts";

async function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	return callback(noopTelemetrySpan);
}

const noopCounter: TelemetryCounter = Object.freeze({ add: () => {} });
const noopUpDownCounter: TelemetryUpDownCounter = Object.freeze({ add: () => {} });
const noopHistogram: TelemetryHistogram = Object.freeze({ record: () => {} });

/** Shared instruments that never inspect or retain metadata, measurements, or contexts. */
export const NOOP_TELEMETRY_METRICS: TelemetryMetrics = Object.freeze({
	counter: () => noopCounter,
	upDownCounter: () => noopUpDownCounter,
	histogram: () => noopHistogram,
});

/** Shared propagation capability that neither inspects nor retains its inputs. */
export const NOOP_TELEMETRY_PROPAGATION: TelemetryPropagation = Object.freeze({
	inject: () => undefined,
	extract: () => NOOP_TELEMETRY_CONTEXT,
});

const noopTelemetrySpan: TelemetrySpan = {
	metrics: NOOP_TELEMETRY_METRICS,
	propagation: NOOP_TELEMETRY_PROPAGATION,
	startSpan: startNoopSpan,
	addLink: () => {},
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
};
Object.freeze(noopTelemetrySpan);

/** Shared telemetry context used when an application does not provide one. */
export const NOOP_TELEMETRY_CONTEXT: TelemetrySpan = noopTelemetrySpan;
