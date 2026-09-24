# @earendil-works/pi-otel

OTLP/HTTP span exporter for the pi [telemetry contract](../telemetry/README.md). The contract stays
backend-neutral and ships no exporter; this package is where a host sends spans to a collector —
SigNoz, Jaeger, Tempo, or any OTLP endpoint.

## Concept

`OtlpTelemetryContext` implements the contract's `TelemetryContext`. It wraps the contract's
in-process reference implementation, so span assignment, status, events, and passivity are the
contract's — the exporter only adds start-time tracking, W3C 128/64-bit identifiers, OTLP/JSON
conversion, and a bounded async queue.

```ts
import { createOtlpTelemetryContext } from "@earendil-works/pi-otel";
import { withTelemetryContext } from "@earendil-works/pi-agent-core";

const otlp = createOtlpTelemetryContext({
	endpoint: "http://127.0.0.1:4318",
	headers: { Authorization: `Bearer ${token}` },
	serviceName: "pi-worker",
	resourceAttributes: { "run.id": runId },
});

// The contract's context model is invocation-scoped: layer the exporter onto
// the caller's context at the invocation boundary, one line per process root.
const context = withTelemetryContext(otlp, callerContext);
await harness.prompt(options, context);
await otlp.close(); // final flush at shutdown
```

Or from the standard environment surface — returns `undefined` when export is disabled, so it
composes with the contract's `NOOP_TELEMETRY_CONTEXT`:

```ts
import { createOtlpTelemetryContextFromEnv } from "@earendil-works/pi-otel";

const context = createOtlpTelemetryContextFromEnv() ?? NOOP_TELEMETRY_CONTEXT;
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `OTEL_ENABLED` | Set to `false`, `0`, `no`, or `off` to disable span export |
| `OTEL_TRACES_EXPORTER` | `otlp` or `otlp/http` to export; `none` (or any non-otlp value) disables |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP HTTP traces URL; overrides `OTEL_EXPORTER_OTLP_ENDPOINT` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; the exporter appends `/v1/traces` unless the value already ends with it |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Extra request headers, `key=value,key2=value2`; overrides `OTEL_EXPORTER_OTLP_HEADERS` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra request headers, same encoding |
| `OTEL_SERVICE_NAME` | The resource `service.name`; defaults to `pi` |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, `key=value,key2=value2` (string values) |
| `OTEL_BSP_MAX_QUEUE_SIZE` | Bounded FIFO queue size; default `16384` |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Spans per export request; default `512` |
| `OTEL_BSP_SCHEDULE_DELAY` | Flush interval in milliseconds; default `5000`, `0` disables the timer |

Without `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`, export stays
disabled and no network activity happens.

## Tuning

`createOtlpTelemetryContext(options)` exposes the same knobs as options: `endpoint` (base or full
traces URL), `headers`, `serviceName`, `resourceAttributes`, `maxQueueSize`, `maxBatchSize`,
`scheduleDelayMs`, `retries`, `retryBaseDelayMs`, and `fetchImpl` (injectable for tests).

## Guarantee: never block, never re-raise

Telemetry is best-effort on every path:

- spans never block or delay the work they describe (export runs on an unref'd interval and on
  explicit `flush()`/`close()`);
- the queue is bounded; when it fills, the oldest span is dropped and counted;
- network failures, `408`, `429`, and `5xx` are retried with a bounded doubling backoff
  (default: 2 retries, 250 ms base), then the batch is dropped and counted;
- `401`/`403` is treated as a fatal credential fault: export stops, queued spans are dropped and
  counted, and one line goes to stderr. Telemetry does not re-raise — retrying into a
  credential wall would only mask the original run;
- other `4xx` responses drop the batch without retry;
- loss is observable: `getDroppedSpanCount()`, `getExportedSpanCount()`, `getFatalError()`.

## Wire format

OTLP/JSON, one request per batch. Resource carries the configured attributes plus the
authoritative `service.name`; scope is `@earendil-works/pi-otel`. IDs are fresh W3C
128-bit/64-bit hex per root span (all-zero IDs are rejected per W3C Trace Context); event and
span-end timestamps carry millisecond precision, and a span's end time is its observed
settlement time (or export-observation time if that was not recorded), so the timeline stays
honest about when work actually finished.

## Guarantees from the contract

The adapter runs the contract's `createTelemetryAdapterConformance` suite: atomic settlement,
identical rejection propagation, parent/child binding under concurrency, explicit-status
behavior, and passivity against hostile span payloads.
