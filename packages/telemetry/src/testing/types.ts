import type { TelemetryContext, TelemetryMetrics, TelemetryPropagation } from "../index.ts";
import type { RecordedTelemetryMeasurement, RecordedTelemetrySpan } from "../memory.ts";

/** A fresh adapter instance and normalized snapshot reader owned by one conformance case. */
export interface TelemetryAdapterFixture extends AsyncDisposable {
	readonly context: TelemetryContext;
	readonly propagation?: TelemetryPropagation;
	readonly metrics?: TelemetryMetrics;
	getMetrics?(): Promise<readonly RecordedTelemetryMeasurement[]>;
	getSpans(): Promise<readonly RecordedTelemetrySpan[]>;
}

/** Creates an isolated adapter fixture for one conformance case. */
export type TelemetryAdapterFixtureFactory = () => Promise<TelemetryAdapterFixture>;

/** A runner-independent conformance case that can be registered with any test framework. */
export interface TelemetryAdapterConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
