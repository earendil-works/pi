import type {
	MetricQuery,
	SpanAttributes,
	SpanLink,
	SpanOptions,
	SpanStatus,
	StoredMetric,
	StoredSpan,
	StoredTrace,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryPropagation,
	TelemetrySpan,
	TelemetryStore,
	TraceQuery,
} from "./index.ts";
import type {
	HistogramOptions,
	InstrumentOptions,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryUpDownCounter,
} from "./metrics.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetryLink {
	readonly context: Readonly<TelemetryCarrier>;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetrySpan {
	readonly id: number;
	/** Local parent ID, or null for roots and parents owned by another recorder. */
	readonly parentId: number | null;
	readonly context: Readonly<TelemetryCarrier>;
	readonly parentContext: Readonly<TelemetryCarrier> | null;
	readonly links: readonly RecordedTelemetryLink[];
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}

export interface RecordedTelemetryMeasurement {
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly name: string;
	readonly description?: string;
	readonly unit?: string;
	readonly boundaries?: readonly number[];
	readonly value: number;
	readonly attributes: Readonly<SpanAttributes>;
	readonly context: Readonly<TelemetryCarrier> | null;
}

interface MutableRecordedTelemetryEvent {
	timeMs: number;
	name: string;
	attributes: SpanAttributes;
}

interface MutableRecordedTelemetrySpan {
	startedMs: number;
	clock: number;
	endedMs?: number;
	id: number;
	parentId: number | null;
	context: TelemetryCarrier;
	parentContext: TelemetryCarrier | null;
	links: RecordedTelemetryLink[];
	name: string;
	attributes: SpanAttributes;
	events: MutableRecordedTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	endSequence?: number;
}

interface InMemoryParent {
	context: TelemetryCarrier;
	localId: number | null;
	span?: MutableRecordedTelemetrySpan;
}

function carrierId(carrier: Readonly<TelemetryCarrier>): string {
	return `${carrier["pi-memory-scope"]}:${carrier["pi-memory-span"]}`;
}

// Identity survives settlement without exposing backend IDs on the generic context contract.
const contextCarriers = new WeakMap<TelemetryContext, TelemetryCarrier>();

interface InMemoryTelemetryState {
	metrics: TelemetryMetrics;
	propagation: TelemetryPropagation;
	scope: string;
	spans: MutableRecordedTelemetrySpan[];
	measurements: { intervalMs: number; measurement: RecordedTelemetryMeasurement }[];
	nextSpanId: number;
	nextEndSequence: number;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(attributes ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]),
	);
}

function copyLink(link: SpanLink): RecordedTelemetryLink | undefined {
	const context = contextCarriers.get(link.context);
	return context ? { context: { ...context }, attributes: copyAttributes(link.attributes) } : undefined;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function createSpan(
	state: InMemoryTelemetryState,
	parent: InMemoryParent | undefined,
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	const name = options.name;
	const attributes = copyAttributes(options.attributes);
	const links: RecordedTelemetryLink[] = [];
	for (const link of options.links ?? []) {
		const copy = copyLink(link);
		if (copy) links.push(copy);
	}
	const id = state.nextSpanId++;
	return {
		startedMs: Date.now(),
		clock: performance.now(),
		id,
		parentId: parent?.localId ?? null,
		context: {
			"pi-memory-scope": state.scope,
			"pi-memory-span": String(id),
			"pi-memory-trace": parent?.context["pi-memory-trace"] ?? `${state.scope}:${id}`,
		},
		parentContext: parent ? { ...parent.context } : null,
		links,
		name,
		attributes,
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
	};
}

function startInertSpan<T>(
	state: InMemoryTelemetryState,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
		callback({
			...noop,
			metrics: state.metrics,
			propagation: state.propagation,
			startSpan: <Result>(
				childOptions: SpanOptions,
				childCallback: (span: TelemetrySpan) => Result | Promise<Result>,
			) => startInertSpan(state, childOptions, childCallback),
		}),
	);
}

async function startInMemorySpan<T>(
	state: InMemoryTelemetryState,
	parent: InMemoryParent | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.span?.settled) return startInertSpan(state, options, callback);

	const recordedSpan = createSpan(state, parent, options);
	state.spans.push(recordedSpan);

	const span: TelemetrySpan = {
		metrics: state.metrics,
		propagation: state.propagation,
		startSpan: <Result>(
			childOptions: SpanOptions,
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) =>
			startInMemorySpan(
				state,
				{ context: recordedSpan.context, localId: recordedSpan.id, span: recordedSpan },
				childOptions,
				childCallback,
			),
		addLink(link) {
			if (recordedSpan.settled) return;
			const copy = copyLink(link);
			if (copy) recordedSpan.links.push(copy);
		},
		addEvent(name, attributes) {
			if (recordedSpan.settled) return;
			recordedSpan.events.push({
				name,
				timeMs: performance.now() - recordedSpan.clock,
				attributes: copyAttributes(attributes),
			});
		},
		setAttributes(attributes) {
			if (recordedSpan.settled) return;
			recordedSpan.attributes = { ...recordedSpan.attributes, ...copyAttributes(attributes) };
		},
		setStatus(status) {
			if (recordedSpan.settled) return;
			recordedSpan.status = copyStatus(status);
			recordedSpan.explicitStatus = true;
		},
	};

	contextCarriers.set(span, recordedSpan.context);

	try {
		return await callback(span);
	} catch (error) {
		if (!recordedSpan.explicitStatus)
			recordedSpan.status =
				error instanceof Error
					? { status: "error", error: { name: error.name, message: error.message } }
					: { status: "error" };
		throw error;
	} finally {
		recordedSpan.settled = true;
		recordedSpan.endedMs = recordedSpan.startedMs + performance.now() - recordedSpan.clock;
		recordedSpan.endSequence = state.nextEndSequence++;
	}
}

function createMeasurementRecorder(
	state: InMemoryTelemetryState,
	kind: RecordedTelemetryMeasurement["kind"],
	name: string,
	options?: HistogramOptions,
): (value: number, attributes?: SpanAttributes, context?: TelemetryContext) => void {
	const description = options?.description;
	const unit = options?.unit;
	const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
	const metadata = {
		kind,
		name,
		...(description === undefined ? {} : { description }),
		...(unit === undefined ? {} : { unit }),
		...(boundaries === undefined ? {} : { boundaries }),
	};
	return (value, attributes, context) => {
		const carrier = context === undefined ? undefined : contextCarriers.get(context);
		state.measurements.push({
			intervalMs: Math.floor(Date.now() / 10_000) * 10_000,
			measurement: {
				...metadata,
				value,
				attributes: copyAttributes(attributes),
				context: carrier ? { ...carrier } : null,
			},
		});
	};
}

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
export class InMemoryTelemetryContext
	implements TelemetryContext, TelemetryPropagation, TelemetryMetrics, TelemetryStore
{
	readonly metrics: TelemetryMetrics = this;
	readonly propagation: TelemetryPropagation = this;
	private readonly state: InMemoryTelemetryState = {
		metrics: this,
		propagation: this,
		scope: crypto.randomUUID(),
		spans: [],
		measurements: [],
		nextSpanId: 1,
		nextEndSequence: 1,
	};

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	/** Returns a detached carrier for a known span or extracted parent, including settled spans. */
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const carrier = contextCarriers.get(context);
		return carrier ? { ...carrier } : undefined;
	}

	/** Missing or non-string carrier identities fall back to this recorder's root context. */
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const scope = carrier?.["pi-memory-scope"];
		const span = carrier?.["pi-memory-span"];
		const traceId = carrier?.["pi-memory-trace"];
		if (typeof scope !== "string" || typeof span !== "string" || typeof traceId !== "string") return this;
		const context = { "pi-memory-scope": scope, "pi-memory-span": span, "pi-memory-trace": traceId };
		const localId = scope === this.state.scope ? Number(span) : null;
		const parent: TelemetryContext = {
			metrics: this,
			propagation: this,
			startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) =>
				startInMemorySpan(this.state, { context, localId }, options, callback),
		};
		contextCarriers.set(parent, context);
		return parent;
	}

	counter(name: string, options?: InstrumentOptions): TelemetryCounter {
		return { add: createMeasurementRecorder(this.state, "counter", name, options) };
	}

	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter {
		return { add: createMeasurementRecorder(this.state, "upDownCounter", name, options) };
	}

	histogram(name: string, options?: HistogramOptions): TelemetryHistogram {
		return { record: createMeasurementRecorder(this.state, "histogram", name, options) };
	}

	private storedSpans(): StoredSpan[] {
		return this.state.spans
			.filter((span) => span.settled)
			.map((span) => ({
				id: carrierId(span.context),
				traceId: span.context["pi-memory-trace"]!,
				...(span.parentContext ? { parentId: carrierId(span.parentContext) } : {}),
				name: span.name,
				startedMs: span.startedMs,
				endedMs: span.endedMs!,
				attributes: copyAttributes(span.attributes),
				events: span.events.map((event) => ({
					name: event.name,
					timeMs: event.timeMs,
					attributes: copyAttributes(event.attributes),
				})),
				links: span.links.map((link) => ({
					traceId: link.context["pi-memory-trace"]!,
					spanId: carrierId(link.context),
					attributes: copyAttributes(link.attributes),
				})),
				status: copyStatus(span.status),
			}))
			.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	async getTrace(traceId: string): Promise<StoredTrace | undefined> {
		const spans = this.storedSpans().filter((span) => span.traceId === traceId);
		return spans.length ? { traceId, spans } : undefined;
	}

	async findTraces(query: TraceQuery = {}): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
		const limit = query.limit ?? 20;
		const after = query.cursor === undefined ? undefined : (JSON.parse(query.cursor) as [number, string]);
		const grouped = new Map<string, { traceId: string; spans: StoredSpan[] }>();
		for (const span of this.storedSpans()) {
			let trace = grouped.get(span.traceId);
			if (!trace) {
				trace = { traceId: span.traceId, spans: [] };
				grouped.set(span.traceId, trace);
			}
			trace.spans.push(span);
		}
		const matches = [...grouped.values()]
			.filter((trace) => {
				const first = trace.spans[0]!;
				return (
					(query.name === undefined || first.name === query.name) &&
					(query.startMin === undefined || first.startedMs >= query.startMin) &&
					(query.startMax === undefined || first.startedMs <= query.startMax) &&
					(!after || first.startedMs < after[0] || (first.startedMs === after[0] && trace.traceId > after[1])) &&
					(!query.errors || trace.spans.some((span) => span.status.status === "error")) &&
					(!query.attributes ||
						trace.spans.some((span) =>
							Object.entries(query.attributes!).every(([key, value]) => span.attributes[key] === value),
						))
				);
			})
			.sort(
				(a, b) =>
					b.spans[0]!.startedMs - a.spans[0]!.startedMs ||
					(a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0),
			);
		const traces = matches.slice(0, limit);
		const last = traces.at(-1)!;
		return {
			traces,
			...(matches.length > limit ? { cursor: JSON.stringify([last.spans[0]!.startedMs, last.traceId]) } : {}),
		};
	}

	/** Read raw measurements as count-one rows, without changing getMetrics() snapshots. */
	async findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]> {
		return this.state.measurements
			.filter(
				({ intervalMs, measurement }) =>
					measurement.name === query.name &&
					(query.startMin === undefined || intervalMs >= query.startMin) &&
					(query.startMax === undefined || intervalMs <= query.startMax) &&
					Object.entries(query.attributes ?? {}).every(([key, value]) => measurement.attributes[key] === value),
			)
			.map(({ intervalMs, measurement }) => ({
				intervalMs,
				name: measurement.name,
				kind: measurement.kind,
				...(measurement.unit === undefined ? {} : { unit: measurement.unit }),
				attributes: copyAttributes(measurement.attributes),
				count: 1,
				sum: measurement.value,
				min: measurement.value,
				max: measurement.value,
			}));
	}

	/** Returns detached measurements in recording order, without aggregation. */
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map(({ measurement }) => ({
			...measurement,
			...(measurement.boundaries === undefined ? {} : { boundaries: [...measurement.boundaries] }),
			attributes: copyAttributes(measurement.attributes),
			context: measurement.context ? { ...measurement.context } : null,
		}));
	}

	/** Returns detached snapshots in span-start order. */
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			context: { ...span.context },
			parentContext: span.parentContext ? { ...span.parentContext } : null,
			links: span.links.map((link) => ({
				context: { ...link.context },
				attributes: copyAttributes(link.attributes),
			})),
			name: span.name,
			attributes: copyAttributes(span.attributes),
			events: span.events.map((event) => ({
				name: event.name,
				attributes: copyAttributes(event.attributes),
			})),
			status: copyStatus(span.status),
			settled: span.settled,
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}
}
