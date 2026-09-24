import {
	InMemoryTelemetryContext,
	type RecordedTelemetrySpan,
	type SpanOptions,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { convertRecordedSpan, type OtlpSpan, type OtlpTraceRequest, randomId, toOtlpKeyvalues } from "./otlp.ts";

const SCOPE_NAME = "@earendil-works/pi-otel";
const DEFAULT_SERVICE_NAME = "pi";
const DEFAULT_MAX_QUEUE_SIZE = 16_384;
const DEFAULT_MAX_BATCH_SIZE = 512;
const DEFAULT_SCHEDULE_DELAY_MS = 5_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

export interface OtlpTelemetryContextOptions {
	/**
	 * The OTLP/HTTP endpoint: a base URL (the exporter appends `/v1/traces`) or a
	 * complete traces URL. Trailing slashes are ignored.
	 */
	endpoint: string;
	/** Extra request headers, merged over `content-type`. */
	headers?: Record<string, string>;
	/** The resource `service.name`. Defaults to `pi`. */
	serviceName?: string;
	/** Extra resource attributes. A `service.name` entry is ignored (the option wins). */
	resourceAttributes?: Record<string, string | number | boolean>;
	/**
	 * FIFO queue bound on settled-but-unexported spans. The oldest spans are
	 * dropped when the bound is exceeded. Default 16384.
	 */
	maxQueueSize?: number;
	/** Span count per export request. Default 512. */
	maxBatchSize?: number;
	/** Flush interval in milliseconds. `0` disables the timer; `flush()` and `close()` still work. Default 5000. */
	scheduleDelayMs?: number;
	/** Retries per batch for network failures and 408/429/5xx responses. Default 2. */
	retries?: number;
	/** Base retry delay in milliseconds; doubles per retry. Default 250. */
	retryBaseDelayMs?: number;
	/** Fetch implementation. Defaults to `globalThis.fetch`; injectable for tests. */
	fetchImpl?: typeof fetch;
}

interface ResolvedOptions {
	endpoint: string;
	headers: Record<string, string>;
	serviceName: string;
	resourceAttributes: Record<string, string | number | boolean>;
	maxQueueSize: number;
	maxBatchSize: number;
	retries: number;
	retryBaseDelayMs: number;
	fetch: typeof fetch;
}

interface PendingSpan {
	endSequence: number;
	span: OtlpSpan;
}

interface SpanTimes {
	startNs: bigint;
	endNs?: bigint;
}

interface SpanIds {
	traceId: string;
	spanId: string;
}

type BatchOutcome = "acked" | "dropped" | "fatal";

const unixNanoNow = (): bigint => BigInt(Math.floor(Date.now())) * 1_000_000n;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function positiveInt(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Math.trunc(Number(value));
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Math.trunc(Number(value));
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeEndpoint(raw: string): string {
	let endpoint = raw.trim().replace(/\/+$/, "");
	if (!endpoint.endsWith("/v1/traces")) endpoint += "/v1/traces";
	return endpoint;
}

/**
 * A {@link TelemetryContext} that exports spans to an OTLP/HTTP endpoint.
 *
 * The context wraps the in-process reference implementation from the telemetry
 * contract, so span assignment, status, event, and passivity semantics are the
 * contract's; the exporter tracks start times and W3C identifiers passively.
 *
 * Settlement order is arbitrary (a child settles before its parent), so spans
 * are collected through a small waiter set rather than by sequence: every
 * recorded span is observed once, and settled spans are enqueued exactly once
 * regardless of the order they settle in.
 *
 * Spans started through a parent's {@link TelemetrySpan} API (rather than
 * through this context) are not timed by the contract. For those, the exporter
 * synthesizes a start time when the span is collected, which bounds the span
 * inside its parent's interval rather than misplacing it.
 *
 * Export is strictly best-effort:
 *
 * - spans never block or delay the work they describe;
 * - the FIFO queue is bounded; the oldest unexported spans are dropped first;
 * - network failures and 408/429/5xx are retried with a bounded, doubling
 *   backoff, then the batch is dropped and counted;
 * - 401/403 is a fatal credential fault: export stops, queued spans are dropped
 *   and counted, and one diagnostic line goes to stderr (telemetry never
 *   re-raises, and retrying into a credential wall is pointless);
 * - other 4xx responses drop the batch without retry;
 * - loss is observable through {@link getDroppedSpanCount}.
 */
export class OtlpTelemetryContext implements TelemetryContext {
	private readonly memory = new InMemoryTelemetryContext();
	private readonly resolved: ResolvedOptions;
	private readonly spanTimes = new Map<number, SpanTimes>();
	private readonly spanIds = new Map<number, SpanIds>();
	private readonly pending: PendingSpan[] = [];
	private readonly waiterIds = new Set<number>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private observed = 0;
	private consumedThrough = 0;
	private droppedSpanCount = 0;
	private exportedSpanCount = 0;
	private fatalError: string | undefined;
	private closed = false;
	private draining = false;

	constructor(options: OtlpTelemetryContextOptions) {
		const maxQueueSize = positiveInt(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
		const maxBatchSize = Math.min(positiveInt(options.maxBatchSize, DEFAULT_MAX_BATCH_SIZE), maxQueueSize);
		this.resolved = {
			endpoint: normalizeEndpoint(options.endpoint),
			headers: options.headers ?? {},
			serviceName: options.serviceName ?? DEFAULT_SERVICE_NAME,
			resourceAttributes: options.resourceAttributes ?? {},
			maxQueueSize,
			maxBatchSize,
			retries: nonNegativeInt(options.retries, DEFAULT_RETRIES),
			retryBaseDelayMs: nonNegativeInt(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS),
			fetch: options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch),
		};
		const scheduleDelayMs = nonNegativeInt(options.scheduleDelayMs, DEFAULT_SCHEDULE_DELAY_MS);
		if (scheduleDelayMs > 0) {
			this.timer = setInterval(() => {
				void this.flush();
			}, scheduleDelayMs);
			this.timer.unref();
		}
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		const startNs = unixNanoNow();
		const countBefore = this.memory.getSpans().length;
		const result = this.memory.startSpan(options, callback);
		const created = this.memory.getSpans()[countBefore];
		if (created) {
			this.trackSpanStart(created, startNs);
			// Passive settlement-time observation. The reference implementation
			// settles the span before its returned promise settles, so either
			// handler observes the real end time. Neither changes the result.
			void result.then(
				() => this.noteSpanEnd(created.id),
				() => this.noteSpanEnd(created.id),
			);
		}
		return result;
	}

	/** Detached snapshots of the recorded spans, in span-start order. */
	getRecordedSpans(): readonly RecordedTelemetrySpan[] {
		return this.memory.getSpans();
	}

	/** Number of settled spans dropped without a successful export. */
	getDroppedSpanCount(): number {
		return this.droppedSpanCount;
	}

	/** Number of spans acknowledged by the endpoint. */
	getExportedSpanCount(): number {
		return this.exportedSpanCount;
	}

	/** Present once a fatal ingest fault (401/403) has stopped exporting. */
	getFatalError(): string | undefined {
		return this.fatalError;
	}

	/**
	 * Collects settled spans and sends what the queue holds, in batches. One
	 * drain runs at a time; overlapping calls are skipped. A no-op after
	 * {@link close}.
	 */
	async flush(): Promise<void> {
		if (this.closed || this.draining) return;
		this.draining = true;
		try {
			await this.drain();
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Performs one final drain, then stops the schedule and the context.
	 * Spans still unexported after the final attempt are counted as dropped.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.draining = true;
		try {
			await this.drain();
			this.droppedSpanCount += this.pending.length;
			this.pending.length = 0;
		} finally {
			this.draining = false;
		}
	}

	private async drain(): Promise<void> {
		for (;;) {
			this.collectSettled();
			if (this.pending.length === 0 || this.fatalError) break;
			const batch = this.pending.splice(0, this.resolved.maxBatchSize);
			for (const entry of batch) this.consumedThrough = Math.max(this.consumedThrough, entry.endSequence);
			const outcome = await this.sendBatch(batch.map((entry) => entry.span));
			if (outcome === "acked") this.exportedSpanCount += batch.length;
			if (outcome === "fatal") break;
		}
		if (this.fatalError) {
			this.droppedSpanCount += this.pending.length;
			this.pending.length = 0;
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			this.reportFatalError();
		}
	}

	private trackSpanStart(span: RecordedTelemetrySpan, startNs: bigint): void {
		const parent = span.parentId === null ? undefined : this.spanIds.get(span.parentId);
		this.spanIds.set(span.id, {
			traceId: parent?.traceId ?? randomId(16),
			spanId: randomId(8),
		});
		this.spanTimes.set(span.id, { startNs });
	}

	private noteSpanEnd(id: number): void {
		try {
			const entry = this.spanTimes.get(id);
			if (entry && entry.endNs === undefined) entry.endNs = unixNanoNow();
		} catch {
			// Passive observation must never affect the recorded span.
		}
	}

	private collectSettled(): void {
		const spans = this.memory.getSpans();
		for (let i = this.observed; i < spans.length; i += 1) {
			const span = spans[i];
			this.observed = i + 1;
			if (!span?.settled) {
				this.waiterIds.add(span.id);
				continue;
			}
			this.enqueueSpan(span);
		}
		// `getSpans()` returns detached snapshots, so waiters are tracked by id
		// and re-read here; the reference would never observe settlement.
		if (this.waiterIds.size > 0) {
			const current = this.memory.getSpans();
			for (const id of this.waiterIds) {
				const span = current[id - 1];
				if (span?.settled) {
					this.waiterIds.delete(id);
					this.enqueueSpan(span);
				}
			}
		}
		while (this.pending.length > this.resolved.maxQueueSize) {
			this.pending.shift();
			this.droppedSpanCount += 1;
		}
	}

	private enqueueSpan(span: RecordedTelemetrySpan): void {
		const ids = this.spanIds.get(span.id) ?? this.synthesizeIds(span);
		const times = this.spanTimes.get(span.id) ?? this.synthesizeTimes(span);
		const parentSpanId = span.parentId === null ? undefined : this.spanIds.get(span.parentId)?.spanId;
		this.pending.push({
			endSequence: span.endSequence ?? this.consumedThrough,
			span: convertRecordedSpan(span, ids, parentSpanId, times),
		});
	}

	/**
	 * Spans started through a parent's {@link TelemetrySpan} API skip the
	 * context wrapper, so their identifiers are assigned lazily here: from the
	 * parent's trace when it is known, fresh otherwise. Stored so deeper
	 * children keep the same trace.
	 */
	private synthesizeIds(span: RecordedTelemetrySpan): SpanIds {
		const ids: SpanIds = {
			traceId: span.parentId === null ? randomId(16) : (this.spanIds.get(span.parentId)?.traceId ?? randomId(16)),
			spanId: randomId(8),
		};
		this.spanIds.set(span.id, ids);
		return ids;
	}

	/**
	 * The contract does not timestamp spans, so untracked spans are bounded
	 * into their nearest ancestor's interval: start at the ancestor's start,
	 * end at the ancestor's end when known (a span ends no later than its
	 * parent), else zero duration at the start. Honest about the loss; never
	 * misplaces a span outside its tree.
	 */
	private synthesizeTimes(span: RecordedTelemetrySpan, depth = 0): SpanTimes {
		const spans = this.memory.getSpans();
		const parent = span.parentId === null ? undefined : spans[span.parentId - 1];
		let parentTimes = parent ? this.spanTimes.get(parent.id) : undefined;
		if (!parentTimes && parent && depth < 256) parentTimes = this.synthesizeTimes(parent, depth + 1);
		const startNs = parentTimes?.startNs ?? unixNanoNow();
		const times: SpanTimes = { startNs, endNs: parentTimes?.endNs ?? startNs };
		this.spanTimes.set(span.id, times);
		return times;
	}

	private async sendBatch(spans: readonly OtlpSpan[]): Promise<BatchOutcome> {
		const body = JSON.stringify(this.buildRequest(spans));
		const maxAttempts = this.resolved.retries + 1;
		for (let attempt = 0; ; attempt += 1) {
			try {
				const response = await this.resolved.fetch(this.resolved.endpoint, {
					method: "POST",
					headers: { "content-type": "application/json", ...this.resolved.headers },
					body,
				});
				if (response.status >= 200 && response.status < 300) return "acked";
				if (response.status === 401 || response.status === 403) {
					this.fatalError = `OTLP ingest rejected with HTTP ${response.status}; span export stopped`;
					this.droppedSpanCount += spans.length;
					return "fatal";
				}
				const retryable =
					response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
				if (!retryable || attempt >= maxAttempts - 1) {
					this.droppedSpanCount += spans.length;
					return "dropped";
				}
			} catch {
				// Network failure: retried like a 5xx, dropped once exhausted.
				if (attempt >= maxAttempts - 1) {
					this.droppedSpanCount += spans.length;
					return "dropped";
				}
			}
			await delay(this.resolved.retryBaseDelayMs * 2 ** attempt);
		}
	}

	private buildRequest(spans: readonly OtlpSpan[]): OtlpTraceRequest {
		const resource = toOtlpKeyvalues(this.resolved.resourceAttributes).filter(
			(keyvalue) => keyvalue.key !== "service.name",
		);
		resource.push({ key: "service.name", value: { stringValue: this.resolved.serviceName } });
		return {
			resourceSpans: [
				{
					resource: { attributes: resource },
					scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: [...spans] }],
				},
			],
		};
	}

	private reportFatalError(): void {
		if (!this.fatalError) return;
		try {
			process.stderr.write(`pi-otel: ${this.fatalError}; dropped ${this.droppedSpanCount} span(s)\n`);
		} catch {
			// Diagnostics must never fail the host.
		}
	}
}

/** Convenience factory mirroring the constructor. */
export function createOtlpTelemetryContext(options: OtlpTelemetryContextOptions): OtlpTelemetryContext {
	return new OtlpTelemetryContext(options);
}
