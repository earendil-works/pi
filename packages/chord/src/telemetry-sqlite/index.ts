import {
	type InstrumentOptions,
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanLink,
	type SpanOptions,
	type SpanStatus,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
	type TelemetryStore,
} from "@earendil-works/pi-telemetry";
import { applySqliteMigrations, type SqliteDatabase, type SqliteValue } from "../sqlite/index.ts";
import { findMetrics, findTraces, getTrace } from "./store.ts";

export interface SqliteTelemetryOptions {
	/** Retain seven days by default. Cleanup runs in the flush transaction. */
	readonly retentionMs?: number;
	/** Settled spans awaiting commit, including the in-flight batch. Defaults to 10,000.
	 * Also bounds pending metric interval/series pairs independently. */
	readonly maxQueuedSpans?: number;
}

export interface SqliteTelemetry extends TelemetryContext, TelemetryStore {
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
	readonly droppedSpans: number;
	readonly droppedMeasurements: number;
	/** Persist settled spans and completed ten-second metric intervals. */
	flush(): Promise<void>;
	/** Stop recording and drain, including partial metric intervals. Does not close the database. */
	close(): Promise<void>;
}

type Identity = { id: string; traceId: string };
type Link = { trace_id: string; span_id: string; attributes?: SpanAttributes };
type Metric = {
	interval: number;
	key: string;
	name: string;
	kind: "counter" | "upDownCounter" | "histogram";
	unit: string | null;
	attributes: string;
	count: number;
	sum: number;
	min: number;
	max: number;
};
const identities = new WeakMap<TelemetryContext, Identity>();
const carrierKey = "pi-sqlite-span";
const traceKey = "pi-sqlite-trace";
const intervalMs = 10_000;

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(attributes ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
	);
}

function copyLink(link: SpanLink): Link | undefined {
	const identity = identities.get(link.context);
	return identity
		? { trace_id: identity.traceId, span_id: identity.id, attributes: copyAttributes(link.attributes) }
		: undefined;
}

class Recorder implements SqliteTelemetry, TelemetryPropagation {
	readonly propagation: TelemetryPropagation = this;
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: this.measurement("counter", name, options) }),
		upDownCounter: (name, options) => ({ add: this.measurement("upDownCounter", name, options) }),
		histogram: (name, options) => ({ record: this.measurement("histogram", name, options) }),
	};
	droppedSpans = 0;
	droppedMeasurements = 0;
	private readonly db: SqliteDatabase;
	private readonly retention: number;
	private readonly capacity: number;
	private readonly scope = crypto.randomUUID();
	private sequence = 0;
	private readonly spans: SqliteValue[][] = [];
	private readonly measurements = new Map<string, Metric>();
	private inFlightMeasurements = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private stopped = false;
	private failed = false;
	private failure: unknown;
	private writing?: Promise<void>;
	private closing?: Promise<void>;

	constructor(db: SqliteDatabase, retention: number, capacity: number) {
		this.db = db;
		this.retention = retention;
		this.capacity = capacity;
		this.timer = setInterval(() => {
			if (!this.writing) void this.flush().catch(() => {});
		}, 1000);
		this.timer.unref?.();
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.start(undefined, options, callback);
	}

	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const identity = identities.get(context);
		return identity ? { [carrierKey]: identity.id, [traceKey]: identity.traceId } : undefined;
	}

	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const id = carrier?.[carrierKey];
		const traceId = carrier?.[traceKey];
		if (typeof id !== "string" || typeof traceId !== "string") return this;
		const identity = { id, traceId };
		const parent: TelemetryContext = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) => this.start(identity, options, callback),
		};
		identities.set(parent, identity);
		return parent;
	}

	private inert<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
			callback({
				...noop,
				metrics: this.metrics,
				propagation: this,
				startSpan: (options, callback) => this.inert(options, callback),
			}),
		);
	}

	private async start<T>(
		parent: Identity | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (this.stopped) return this.inert(options, callback);
		const name = options.name;
		let attributes = copyAttributes(options.attributes);
		const links: Link[] = [];
		for (const link of options.links ?? []) {
			const copied = copyLink(link);
			if (copied) links.push(copied);
		}
		const id = `${this.scope}:${++this.sequence}`;
		const identity = { id, traceId: parent?.traceId ?? id };
		const started = Date.now();
		const clock = performance.now();
		const events: { name: string; time_ms: number; attributes: SpanAttributes }[] = [];
		let status: SpanStatus = { status: "ok" };
		let explicit = false;
		let settled = false;
		const record = (action: () => void): void => {
			if (!settled && !this.stopped) action();
		};
		const span: TelemetrySpan = {
			metrics: this.metrics,
			propagation: this,
			startSpan: (options, callback) =>
				settled ? this.inert(options, callback) : this.start(identity, options, callback),
			addLink: (link) =>
				record(() => {
					const copied = copyLink(link);
					if (copied) links.push(copied);
				}),
			addEvent: (name, attrs) =>
				record(() => {
					events.push({ name, time_ms: performance.now() - clock, attributes: copyAttributes(attrs) });
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
			if (!this.stopped) {
				if (this.spans.length >= this.capacity) this.droppedSpans++;
				else
					this.spans.push([
						id,
						identity.traceId,
						parent?.id ?? null,
						name,
						started,
						started + performance.now() - clock,
						JSON.stringify(attributes),
						JSON.stringify(events),
						JSON.stringify(links),
						JSON.stringify(status),
					]);
			}
		}
	}

	private measurement(
		kind: Metric["kind"],
		name: string,
		options?: InstrumentOptions,
	): (value: number, attributes?: SpanAttributes) => void {
		const unit = options?.unit ?? null;
		return (value, attributes) => {
			if (this.stopped) return;
			const copied = copyAttributes(attributes);
			const encoded = JSON.stringify(
				Object.fromEntries(
					Object.keys(copied)
						.sort()
						.map((key) => [key, copied[key]]),
				),
			);
			const key = JSON.stringify([name, kind, unit, encoded]);
			const interval = Math.floor(Date.now() / intervalMs) * intervalMs;
			const pendingKey = `${interval}:${key}`;
			const previous = this.measurements.get(pendingKey);
			if (!previous && this.measurements.size + this.inFlightMeasurements >= this.capacity) {
				this.droppedMeasurements++;
				return;
			}
			this.measurements.set(pendingKey, {
				interval,
				key,
				name,
				kind,
				unit,
				attributes: encoded,
				count: (previous?.count ?? 0) + 1,
				sum: (previous?.sum ?? 0) + value,
				min: Math.min(previous?.min ?? value, value),
				max: Math.max(previous?.max ?? value, value),
			});
		};
	}

	/** Readers use committed rows only; flush first to include newly settled spans. */
	readonly getTrace: TelemetryStore["getTrace"] = (traceId) => getTrace(this.db, traceId);
	readonly findTraces: TelemetryStore["findTraces"] = (query) => findTraces(this.db, query);
	readonly findMetrics: TelemetryStore["findMetrics"] = (query) => findMetrics(this.db, query);

	flush(): Promise<void> {
		return this.closing ?? this.drain(false);
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.stopped = true;
			clearInterval(this.timer);
			this.closing = this.drain(true);
		}
		return this.closing;
	}

	private async drain(partial: boolean): Promise<void> {
		while (this.writing) await this.writing;
		if (this.failed) throw this.failure;
		const spans = this.spans.slice();
		const metrics: Metric[] = [];
		const completed = Math.floor(Date.now() / intervalMs) * intervalMs;
		for (const [key, metric] of this.measurements) {
			if (!partial && metric.interval >= completed) continue;
			metrics.push(metric);
			this.measurements.delete(key);
		}
		this.inFlightMeasurements = metrics.length;
		this.writing = Promise.resolve()
			.then(() =>
				this.db.transaction(async (tx) => {
					for (const span of spans)
						await tx.run("INSERT INTO telemetry_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ...span);
					for (const metric of metrics)
						await tx.run(
							`INSERT INTO telemetry_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(interval_ms, series_key) DO UPDATE SET count = count + excluded.count,
				sum = sum + excluded.sum, min = min(min, excluded.min), max = max(max, excluded.max)`,
							metric.interval,
							metric.key,
							metric.name,
							metric.kind,
							metric.unit,
							metric.attributes,
							metric.count,
							metric.sum,
							metric.min,
							metric.max,
						);
					const cutoff = Date.now() - this.retention;
					await tx.run("DELETE FROM telemetry_spans WHERE ended_ms < ?", cutoff);
					await tx.run("DELETE FROM telemetry_metrics WHERE interval_ms < ?", cutoff);
				}),
			)
			.then(() => {
				this.spans.splice(0, spans.length);
			})
			.catch((error: unknown) => {
				this.failed = this.stopped = true;
				this.failure = error;
				this.spans.length = 0;
				this.measurements.clear();
				clearInterval(this.timer);
				throw error;
			})
			.finally(() => {
				this.writing = undefined;
				this.inFlightMeasurements = 0;
			});
		await this.writing;
	}
}

/** Portable, buffered SQLite recorder. Recording never performs SQL; flush runs every second.
 * Only settled spans are stored. Metrics aggregate count/sum/min/max per ten-second interval.
 * A write failure permanently stops recording and is reported by flush and close. */
export async function createSqliteTelemetry(
	db: SqliteDatabase,
	options: SqliteTelemetryOptions = {},
): Promise<SqliteTelemetry> {
	const retention = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
	const capacity = options.maxQueuedSpans ?? 10_000;
	await applySqliteMigrations(
		db,
		[
			{
				version: 1,
				statements: [
					`CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT, started_ms REAL,
			ended_ms REAL NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)`,
					"CREATE INDEX telemetry_spans_ended_ms ON telemetry_spans(ended_ms)",
					"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_ms)",
					"CREATE INDEX telemetry_spans_started_ms ON telemetry_spans(started_ms)",
					`CREATE TABLE telemetry_metrics (interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT,
			unit TEXT, attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key))`,
				],
			},
		],
		{ table: "telemetry_schema" },
	);
	return new Recorder(db, retention, capacity);
}
