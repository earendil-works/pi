import type {
	ExactTelemetryAttributes,
	InferRequiredAndOptionalAttributes,
	SpanAttributes,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetryStartAttributeDefinition,
} from "./index.ts";

export interface InstrumentOptions {
	description?: string;
	unit?: string;
}

export interface HistogramOptions extends InstrumentOptions {
	/** Bucket hints; callers supply finite, strictly increasing values. */
	boundaries?: readonly number[];
}

export interface TelemetryCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

export interface TelemetryUpDownCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

export interface TelemetryHistogram {
	record(value: number, attributes?: SpanAttributes, context?: TelemetryContext): void;
}

/**
 * Optional adapter capability with synchronous factories and recording methods.
 * Typed inputs are trusted; callers supply finite measurements and nonnegative counter increments.
 * Malformed input behavior is unspecified.
 */
export interface TelemetryMetrics {
	counter(name: string, options?: InstrumentOptions): TelemetryCounter;
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter;
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram;
}

export type TelemetryMetricAttributeDefinition = TelemetryStartAttributeDefinition & { cardinality?: "low" };

export type TelemetryMetricDefinition = {
	description: string;
	unit?: string;
	attributes: Record<string, TelemetryMetricAttributeDefinition>;
} & ({ kind: "counter" | "upDownCounter"; boundaries?: never } | { kind: "histogram"; boundaries?: readonly number[] });

type MetricKind = TelemetryMetricDefinition["kind"];
type MetricSchemas = readonly [TelemetrySchemaDefinition, ...TelemetrySchemaDefinition[]];

type MetricsOf<Schema extends TelemetrySchemaDefinition> = Schema extends {
	metrics: infer Metrics extends Record<string, TelemetryMetricDefinition>;
}
	? Metrics
	: Record<never, never>;

type MetricNames<
	Schema extends TelemetrySchemaDefinition,
	Kind extends MetricKind,
> = Schema extends TelemetrySchemaDefinition
	? {
			[Name in keyof MetricsOf<Schema>]: MetricsOf<Schema>[Name] extends { kind: Kind } ? Name : never;
		}[keyof MetricsOf<Schema>] &
			string
	: never;

type MetricByName<
	Schema extends TelemetrySchemaDefinition,
	Name extends string,
> = Schema extends TelemetrySchemaDefinition
	? Name extends keyof MetricsOf<Schema>
		? MetricsOf<Schema>[Name]
		: never
	: never;

type DuplicateMetricNames<
	Schemas extends readonly TelemetrySchemaDefinition[],
	Seen extends string = never,
> = Schemas extends readonly [
	infer Schema extends TelemetrySchemaDefinition,
	...infer Rest extends readonly TelemetrySchemaDefinition[],
]
	? Extract<keyof MetricsOf<Schema>, Seen> | DuplicateMetricNames<Rest, Seen | (keyof MetricsOf<Schema> & string)>
	: never;

type MetricAttributes<Definition extends TelemetryMetricDefinition> = InferRequiredAndOptionalAttributes<
	Definition["attributes"]
>;

type MeasurementArguments<
	Definition extends TelemetryMetricDefinition,
	Attributes extends MetricAttributes<Definition>,
> = {
	[Name in keyof Definition["attributes"]]: Definition["attributes"][Name]["required"] extends true ? Name : never;
}[keyof Definition["attributes"]] extends never
	? [attributes?: ExactTelemetryAttributes<MetricAttributes<Definition>, Attributes>]
	: [attributes: ExactTelemetryAttributes<MetricAttributes<Definition>, Attributes>];

export type SchemaTelemetryCounter<Definition extends TelemetryMetricDefinition> = {
	add<const Attributes extends MetricAttributes<Definition> = MetricAttributes<Definition>>(
		value: number,
		...args: MeasurementArguments<Definition, Attributes>
	): void;
};

export type SchemaTelemetryHistogram<Definition extends TelemetryMetricDefinition> = {
	record<const Attributes extends MetricAttributes<Definition> = MetricAttributes<Definition>>(
		value: number,
		...args: [...MeasurementArguments<Definition, Attributes>, context?: TelemetryContext]
	): void;
};

export interface TypedTelemetryMetrics<Schemas extends MetricSchemas> {
	counter<Name extends MetricNames<Schemas[number], "counter">>(
		name: Name,
	): SchemaTelemetryCounter<MetricByName<Schemas[number], Name>>;
	upDownCounter<Name extends MetricNames<Schemas[number], "upDownCounter">>(
		name: Name,
	): SchemaTelemetryCounter<MetricByName<Schemas[number], Name>>;
	histogram<Name extends MetricNames<Schemas[number], "histogram">>(
		name: Name,
	): SchemaTelemetryHistogram<MetricByName<Schemas[number], Name>>;
}

/** Bind instrument names, kinds, metadata, and exact measurement attributes to one or more schemas. */
export function createTypedMetrics<const Schemas extends MetricSchemas>(
	metrics: TelemetryMetrics,
	schemas: Schemas &
		([DuplicateMetricNames<Schemas>] extends [never]
			? unknown
			: { readonly "duplicate telemetry metric names": DuplicateMetricNames<Schemas> }),
): TypedTelemetryMetrics<Schemas> {
	const definitions = new Map<string, TelemetryMetricDefinition>();
	for (const schema of schemas) {
		for (const [name, definition] of Object.entries(schema.metrics ?? {})) definitions.set(name, definition);
	}
	return {
		counter: (name: string) => metrics.counter(name, definitions.get(name)),
		upDownCounter: (name: string) => metrics.upDownCounter(name, definitions.get(name)),
		histogram: (name: string) => metrics.histogram(name, definitions.get(name)),
	} as unknown as TypedTelemetryMetrics<Schemas>;
}
