// How a page and a worker send what their recorder kept (decisions "Telemetry from browser pages", "The server is the
// one place telemetry is stored"): their host holds the server's telemetry object over the link it has, and each send
// takes one batch from the recorder and calls `ingest` with it; a batch that cannot be sent (no link, a refusal) is
// given up, best effort. One send at a time; nothing is sent while the object is not bound.

import { BACKGROUND_CONTEXT, type Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { PAGE_BATCH_SPANS, PageTelemetry, WORKER_BATCH_ROWS, WorkerTelemetry } from "./batch.ts";
import type { TelemetryBatch, TelemetryRecorder } from "./recorder.ts";

/** A running sender: `send` sends one batch now (with `partial`, the metric intervals not over too), `stop` stops. */
export type TelemetrySender = {
	send(partial: boolean): Promise<void>;
	stop(): void;
};

/** Sends a page's spans (never its metrics) to the server's `PageTelemetry`, at most `PAGE_BATCH_SPANS` a batch. */
export function sendPageTelemetry<P extends Principal>(
	host: Host<P>,
	recorder: TelemetryRecorder,
	context: Context,
): TelemetrySender {
	const held = host.hold(PageTelemetry, {}, context);
	// Spans only: its metrics are taken with them and dropped.
	const waiting = (_partial: boolean) => recorder.queuedSpans > 0;
	return sender(
		recorder,
		PAGE_BATCH_SPANS,
		waiting,
		() => held.release(),
		(batch) => {
			if (held.state.value.kind !== "live") return undefined;
			return held.ingest({ spans: batch.spans }, BACKGROUND_CONTEXT);
		},
	);
}

/** Sends a worker's spans and metrics to the server's `WorkerTelemetry`, at most `WORKER_BATCH_ROWS` spans a batch. */
export function sendWorkerTelemetry<P extends Principal>(
	host: Host<P>,
	recorder: TelemetryRecorder,
	context: Context,
): TelemetrySender {
	const held = host.hold(WorkerTelemetry, {}, context);
	return sender(
		recorder,
		WORKER_BATCH_ROWS,
		(partial) => recorder.pending(partial),
		() => held.release(),
		(batch) => {
			if (held.state.value.kind !== "live" || held.variant !== "worker") return undefined;
			// A batch takes at most `WORKER_BATCH_ROWS` metric rows; more series in one interval are dropped.
			return held.ingest(
				{ spans: batch.spans, metrics: batch.metrics.slice(0, WORKER_BATCH_ROWS) },
				BACKGROUND_CONTEXT,
			);
		},
	);
}

/**
 * The send loop over `call`, which sends a batch, or answers `undefined` when it cannot now (the batch then waits); a
 * send does nothing while `waiting` says nothing waits.
 */
function sender(
	recorder: TelemetryRecorder,
	limit: number,
	waiting: (partial: boolean) => boolean,
	release: () => void,
	call: (batch: TelemetryBatch) => Promise<unknown> | undefined,
): TelemetrySender {
	let sending: Promise<void> | undefined;
	let stopped = false;
	const once = async (partial: boolean): Promise<void> => {
		if (!waiting(partial)) return;
		const batch = recorder.take(partial, limit);
		const sent = call(batch);
		if (sent === undefined) {
			// Not bound now: the batch is queued again (at the back), within the recorder's bound.
			recorder.release();
			recorder.ingest(batch);
			return;
		}
		// Best effort: a refused or lost batch is given up.
		await sent.catch(() => {});
		recorder.release();
	};
	return {
		send: (partial) => {
			if (stopped) return Promise.resolve();
			const next = (sending ?? Promise.resolve()).then(() => once(partial));
			sending = next;
			return next;
		},
		stop: () => {
			stopped = true;
			release();
		},
	};
}
