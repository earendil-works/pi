// The SQLite telemetry store (`@earendil-works/chord/telemetry-sqlite`, decision "Telemetry store", §29): a recorder
// (`TelemetryRecorder`) whose batches are written every second, settled spans one row each (events and links inline,
// times in microseconds) and metrics per series per 10 s, with retention; spans and metrics other processes recorded
// join the same batches (`ingest`, never overwriting a stored span); and the `TelemetryStore` reads over it.

import type {
	StoredMetric,
	StoredSpan,
	TelemetryContext,
	TelemetryMetrics,
	TelemetryPropagation,
	TelemetryStore,
} from "@earendil-works/pi-telemetry";
import type { SqliteDatabase, SqliteExecutor } from "../sqlite/index.ts";
import { seriesKey, sortedAttributes, type TelemetryBatch, TelemetryRecorder } from "../telemetry-ingest/recorder.ts";
import { migrateTelemetryStore } from "./schema.ts";
import { findMetrics, findTraces, getTrace } from "./store.ts";

export type { TelemetryBatch } from "../telemetry-ingest/recorder.ts";

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
	/**
	 * Queues finished spans and metric rows another process recorded, written with the next flush (a span whose id is
	 * stored already is kept as it was); within the queue's bound, the rest dropped and counted. Returns how many
	 * spans it queued. Callers check what they pass: the store writes it as it is.
	 */
	ingest(batch: TelemetryBatch): number;
	/** Persist settled spans and completed ten-second metric intervals. */
	flush(): Promise<void>;
	/** Stop recording and drain, including partial metric intervals. Does not close the database. */
	close(): Promise<void>;
}

/** `ms` in whole microseconds, as the store keeps span times. */
function micros(ms: number): number {
	return Math.round(ms * 1000);
}

class Store implements SqliteTelemetry {
	readonly #recorder: TelemetryRecorder;
	readonly #db: SqliteDatabase;
	readonly #retention: number;
	readonly #timer: ReturnType<typeof setInterval>;
	#failed = false;
	#failure: unknown;
	#writing?: Promise<void>;
	#closing?: Promise<void>;

	constructor(db: SqliteDatabase, retention: number, capacity: number) {
		this.#db = db;
		this.#retention = retention;
		const scope = crypto.randomUUID();
		this.#recorder = new TelemetryRecorder(() => scope, capacity);
		this.#timer = setInterval(() => {
			if (!this.#writing) void this.flush().catch(() => {});
		}, 1000);
		this.#timer.unref?.();
	}

	get metrics(): TelemetryMetrics {
		return this.#recorder.metrics;
	}

	get propagation(): TelemetryPropagation {
		return this.#recorder;
	}

	get droppedSpans(): number {
		return this.#recorder.droppedSpans;
	}

	get droppedMeasurements(): number {
		return this.#recorder.droppedMeasurements;
	}

	readonly startSpan: TelemetryContext["startSpan"] = (options, callback) =>
		this.#recorder.startSpan(options, callback);

	ingest(batch: TelemetryBatch): number {
		return this.#recorder.ingest(batch);
	}

	/** Readers use committed rows only; flush first to include newly settled spans. */
	readonly getTrace: TelemetryStore["getTrace"] = (traceId) => getTrace(this.#db, traceId);
	readonly findTraces: TelemetryStore["findTraces"] = (query) => findTraces(this.#db, query);
	readonly findMetrics: TelemetryStore["findMetrics"] = (query) => findMetrics(this.#db, query);

	flush(): Promise<void> {
		return this.#closing ?? this.#drain(false);
	}

	close(): Promise<void> {
		if (!this.#closing) {
			this.#recorder.stop("keep");
			clearInterval(this.#timer);
			this.#closing = this.#drain(true);
		}
		return this.#closing;
	}

	async #drain(partial: boolean): Promise<void> {
		while (this.#writing) await this.#writing;
		if (this.#failed) throw this.#failure;
		const batch = this.#recorder.take(partial);
		this.#writing = Promise.resolve()
			.then(() =>
				this.#db.transaction(async (tx) => {
					for (const span of batch.spans) await writeSpan(tx, span);
					for (const metric of batch.metrics) await writeMetric(tx, metric);
					const cutoff = Date.now() - this.#retention;
					await tx.run("DELETE FROM telemetry_spans WHERE ended_us < ?", cutoff * 1000);
					await tx.run("DELETE FROM telemetry_metrics WHERE interval_ms < ?", cutoff);
				}),
			)
			.catch((error: unknown) => {
				this.#failed = true;
				this.#failure = error;
				this.#recorder.stop("discard");
				clearInterval(this.#timer);
				throw error;
			})
			.finally(() => {
				this.#writing = undefined;
				this.#recorder.release();
			});
		await this.#writing;
	}
}

/** Writes `span`, unless a span of its id is stored already (an ingested span never replaces one). */
function writeSpan(tx: SqliteExecutor, span: StoredSpan): Promise<void> {
	return tx.run(
		"INSERT OR IGNORE INTO telemetry_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		span.id,
		span.traceId,
		span.parentId ?? null,
		span.name,
		micros(span.startedMs),
		micros(span.endedMs),
		JSON.stringify(span.attributes),
		JSON.stringify(span.events.map(({ name, timeMs, attributes }) => ({ name, time_ms: timeMs, attributes }))),
		JSON.stringify(
			span.links.map(({ traceId, spanId, attributes }) => ({ trace_id: traceId, span_id: spanId, attributes })),
		),
		JSON.stringify(span.status),
	);
}

/** Adds `metric` to its series' row of its interval. */
function writeMetric(tx: SqliteExecutor, metric: StoredMetric): Promise<void> {
	return tx.run(
		`INSERT INTO telemetry_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(interval_ms, series_key) DO UPDATE SET count = count + excluded.count,
		sum = sum + excluded.sum, min = min(min, excluded.min), max = max(max, excluded.max)`,
		metric.intervalMs,
		seriesKey(metric),
		metric.name,
		metric.kind,
		metric.unit ?? null,
		JSON.stringify(sortedAttributes(metric.attributes)),
		metric.count,
		metric.sum,
		metric.min,
		metric.max,
	);
}

/** Portable, buffered SQLite recorder. Recording never performs SQL; flush runs every second.
 * Only settled spans are stored, their times in microseconds (`telemetryNow`). Metrics aggregate count/sum/min/max per
 * ten-second interval. A store of an older version in `db` is migrated (version 2: span times from milliseconds to
 * microseconds, rows kept). A write failure permanently stops recording and is reported by flush and close. */
export async function createSqliteTelemetry(
	db: SqliteDatabase,
	options: SqliteTelemetryOptions = {},
): Promise<SqliteTelemetry> {
	const retention = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
	const capacity = options.maxQueuedSpans ?? 10_000;
	await migrateTelemetryStore(db);
	return new Store(db, retention, capacity);
}
