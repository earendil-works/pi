// Telemetry from pages and workers to the server's store (decisions "Telemetry from browser pages", "The server is
// the one place telemetry is stored"): the recorder pages and workers keep their spans in, the batches and the
// server's objects that take them, the facet serving those, and the senders.

export {
	PAGE_BATCH_SPANS,
	PageBatch,
	PageTelemetry,
	WORKER_BATCH_ROWS,
	WorkerBatch,
	WorkerTelemetry,
} from "./batch.ts";
export {
	PAGE_SPANS_PER_MINUTE,
	type TelemetryIngestOptions,
	type TelemetryIngestTarget,
	telemetryIngestFacet,
} from "./facet.ts";
export { type TelemetryBatch, TelemetryRecorder } from "./recorder.ts";
export { sendPageTelemetry, sendWorkerTelemetry, type TelemetrySender } from "./sender.ts";
