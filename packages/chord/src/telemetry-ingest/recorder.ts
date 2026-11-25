// Chord's telemetry recorder (§29): an adapter keeping settled spans and metric aggregates (per series per 10 s) in a
// bounded queue (past it dropped and counted), until its owner takes them as a batch: the SQLite store writes its
// batches to its file, a page or a worker sends them to the server's telemetry object (`TelemetryIngest`). Its
// carriers name a span by id and trace id; every recorder of a process reads every other's (one carrier format).

import {
	type InstrumentOptions,
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type StoredMetric,
	type StoredSpan,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
	telemetryNow,
} from "@earendil-works/pi-telemetry";

/** What a recorder hands its owner at once: settled spans and metric aggregates. */
export type TelemetryBatch = { readonly spans: StoredSpan[]; readonly metrics: StoredMetric[] };

/** A span's identity in carriers and links: its id and its trace's. */
type Identity = { readonly id: string; readonly traceId: string };

type Metric = StoredMetric & { readonly key: string };

/** The identities of every recorder's spans and extracted parents in this process: links and carriers read them. */
const identities = new WeakMap<TelemetryContext, Identity>();

/** The carrier's keys: a span's id and its trace's (the SQLite store's since slice 9: stored job carriers use them). */
const SPAN_KEY = "pi-sqlite-span";
const TRACE_KEY = "pi-sqlite-trace";

/** The metric interval. */
export const INTERVAL_MS = 10_000;

/**
 * Records spans and metrics in memory for its owner, who takes them in batches (`take`, then `release` once they are
 * written or given up). Span ids are `<scope>:<n>`, `scope` read at the first span (a page's names its host's
 * incarnation, made after the recorder). `capacity` bounds the queued spans, a taken batch's included, and separately
 * the pending metric series.
 */
export class TelemetryRecorder implements TelemetryContext, TelemetryPropagation {
	readonly propagation: TelemetryPropagation = this;
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: this.#measurement("counter", name, options) }),
		upDownCounter: (name, options) => ({ add: this.#measurement("upDownCounter", name, options) }),
		histogram: (name, options) => ({ record: this.#measurement("histogram", name, options) }),
	};
	droppedSpans = 0;
	droppedMeasurements = 0;
	readonly #scope: () => string;
	#prefix: string | undefined;
	readonly #capacity: number;
	#sequence = 0;
	#spans: StoredSpan[] = [];
	#inFlight = 0;
	readonly #measurements = new Map<string, Metric>();
	#inFlightMeasurements = 0;
	#stopped = false;

	constructor(scope: () => string, capacity: number) {
		this.#scope = scope;
		this.#capacity = capacity;
	}

	/** Whether it stopped: later spans are inert, later measurements ignored. */
	get stopped(): boolean {
		return this.#stopped;
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.#start(undefined, options, callback);
	}

	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const identity = identities.get(context);
		return identity ? { [SPAN_KEY]: identity.id, [TRACE_KEY]: identity.traceId } : undefined;
	}

	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const id = carrier?.[SPAN_KEY];
		const traceId = carrier?.[TRACE_KEY];
		// Carriers come from other processes: only their two strings are read, else the root.
		if (typeof id !== "string" || typeof traceId !== "string") return this;
		const identity = { id, traceId };
		const parent: TelemetryContext = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) => this.#start(identity, options, callback),
		};
		identities.set(parent, identity);
		return parent;
	}

	/**
	 * Takes the queued spans (at most `limit`, the oldest) and the metric intervals that are over (every one with
	 * `partial`); the spans keep counting against the capacity until `release`.
	 */
	take(partial: boolean, limit = Number.POSITIVE_INFINITY): TelemetryBatch {
		const spans = this.#spans.length <= limit ? this.#spans : this.#spans.slice(0, limit);
		this.#spans = spans === this.#spans ? [] : this.#spans.slice(limit);
		this.#inFlight = spans.length;
		const metrics: StoredMetric[] = [];
		const current = intervalOf(Date.now());
		for (const [key, { key: _series, ...metric }] of this.#measurements) {
			if (!partial && metric.intervalMs >= current) continue;
			metrics.push(metric);
			this.#measurements.delete(key);
		}
		this.#inFlightMeasurements = metrics.length;
		return { spans, metrics };
	}

	/** The batch taken last was written or given up: its capacity is free again. */
	release(): void {
		this.#inFlight = 0;
		this.#inFlightMeasurements = 0;
	}

	/** How many settled spans wait to be taken. */
	get queuedSpans(): number {
		return this.#spans.length;
	}

	/** Whether spans, or metric intervals that are over (all of them with `partial`), wait to be taken. */
	pending(partial: boolean): boolean {
		if (this.#spans.length > 0) return true;
		const current = intervalOf(Date.now());
		for (const metric of this.#measurements.values()) if (partial || metric.intervalMs < current) return true;
		return false;
	}

	/**
	 * Queues spans and metric rows another process recorded (an ingest), within the capacity; returns how many spans
	 * it queued (the rest dropped and counted).
	 */
	ingest(batch: TelemetryBatch): number {
		if (this.#stopped) return 0;
		let queued = 0;
		for (const span of batch.spans) {
			if (this.#spans.length + this.#inFlight >= this.#capacity) this.droppedSpans++;
			else {
				this.#spans.push(span);
				queued++;
			}
		}
		for (const metric of batch.metrics) this.#merge(metric);
		return queued;
	}

	/** Stops recording; with `discard`, what waits is dropped too (a failed store). */
	stop(discard: "keep" | "discard"): void {
		this.#stopped = true;
		if (discard === "discard") {
			this.#spans = [];
			this.#measurements.clear();
		}
	}

	#inert<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
			callback({
				...noop,
				metrics: this.metrics,
				propagation: this,
				startSpan: (options, callback) => this.#inert(options, callback),
			}),
		);
	}

	async #start<T>(
		parent: Identity | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (this.#stopped) return this.#inert(options, callback);
		let attributes = copyAttributes(options.attributes);
		const links: { traceId: string; spanId: string; attributes: SpanAttributes }[] = [];
		for (const link of options.links ?? []) {
			const copied = copyLink(link);
			if (copied) links.push(copied);
		}
		this.#prefix ??= this.#scope();
		const id = `${this.#prefix}:${++this.#sequence}`;
		const identity = { id, traceId: parent?.traceId ?? id };
		// The start on the clock pi-telemetry's adapters share; the end and events by the monotonic clock from it.
		const started = telemetryNow();
		const clock = performance.now();
		const events: { name: string; timeMs: number; attributes: SpanAttributes }[] = [];
		let status: SpanStatus = { status: "ok" };
		let explicit = false;
		let settled = false;
		const record = (action: () => void): void => {
			if (!settled && !this.#stopped) action();
		};
		const span: TelemetrySpan = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) =>
				settled ? this.#inert(options, callback) : this.#start(identity, options, callback),
			addLink: (link) =>
				record(() => {
					const copied = copyLink(link);
					if (copied) links.push(copied);
				}),
			addEvent: (name, attrs) =>
				record(() => {
					events.push({
						name,
						timeMs: microseconds(performance.now() - clock),
						attributes: copyAttributes(attrs),
					});
				}),
			setAttributes: (attrs) =>
				record(() => {
					attributes = { ...attributes, ...copyAttributes(attrs) };
				}),
			setStatus: (value) =>
				record(() => {
					status =
						value.status === "error" && value.error
							? { status: "error", error: { ...value.error } }
							: { status: value.status };
					explicit = true;
				}),
		};
		identities.set(span, identity);
		try {
			return await callback(span);
		} catch (error) {
			if (!explicit)
				status =
					error instanceof Error
						? { status: "error", error: { name: error.name, message: error.message } }
						: { status: "error" };
			throw error;
		} finally {
			settled = true;
			if (!this.#stopped) {
				if (this.#spans.length + this.#inFlight >= this.#capacity) this.droppedSpans++;
				else
					this.#spans.push({
						id,
						traceId: identity.traceId,
						...(parent === undefined ? {} : { parentId: parent.id }),
						name: options.name,
						startedMs: started,
						endedMs: microseconds(started + performance.now() - clock),
						attributes,
						events,
						links,
						status,
					});
			}
		}
	}

	#measurement(
		kind: StoredMetric["kind"],
		name: string,
		options?: InstrumentOptions,
	): (value: number, attributes?: SpanAttributes) => void {
		const unit = options?.unit;
		return (value, attributes) => {
			if (this.#stopped) return;
			this.#merge({
				intervalMs: intervalOf(Date.now()),
				name,
				kind,
				...(unit === undefined ? {} : { unit }),
				attributes: sortedAttributes(copyAttributes(attributes)),
				count: 1,
				sum: value,
				min: value,
				max: value,
			});
		};
	}

	/** Adds `metric` to its series' pending interval (a new series within the capacity, else dropped and counted). */
	#merge(metric: StoredMetric): void {
		if (this.#stopped) return;
		const key = seriesKey(metric);
		const pendingKey = `${metric.intervalMs}:${key}`;
		const previous = this.#measurements.get(pendingKey);
		if (!previous && this.#measurements.size + this.#inFlightMeasurements >= this.#capacity) {
			this.droppedMeasurements++;
			return;
		}
		this.#measurements.set(pendingKey, {
			...metric,
			key,
			count: (previous?.count ?? 0) + metric.count,
			sum: (previous?.sum ?? 0) + metric.sum,
			min: Math.min(previous?.min ?? metric.min, metric.min),
			max: Math.max(previous?.max ?? metric.max, metric.max),
		});
	}
}

/** A metric's series: its name, kind, unit and attributes (sorted by key), as JSON. */
export function seriesKey(metric: StoredMetric): string {
	return JSON.stringify([
		metric.name,
		metric.kind,
		metric.unit ?? null,
		JSON.stringify(sortedAttributes(metric.attributes)),
	]);
}

/** The start of the metric interval `time` falls in. */
function intervalOf(time: number): number {
	return Math.floor(time / INTERVAL_MS) * INTERVAL_MS;
}

/** `attributes` with their keys in order (a series' attributes as stored). */
export function sortedAttributes(attributes: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.keys(attributes)
			.sort()
			.map((key) => [key, attributes[key]]),
	);
}

/** `ms` rounded to the microsecond, as span times are. */
function microseconds(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(attributes ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
	);
}

function copyLink(link: SpanLink): { traceId: string; spanId: string; attributes: SpanAttributes } | undefined {
	const identity = identities.get(link.context);
	return identity
		? { traceId: identity.traceId, spanId: identity.id, attributes: copyAttributes(link.attributes) }
		: undefined;
}
