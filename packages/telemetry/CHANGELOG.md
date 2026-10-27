# Changelog

## [Unreleased]

### Fixed

- The package root and `./testing` exports have a `source` condition, like `./render`, so workspace tests that resolve with `source` (Durable's and pi-env's, as the Environments workflow runs them) work without a build.

## [1.4.0] - 2026-10-21

### Breaking Changes

- Adapters trust typed instrumentation inputs; behavior for malformed values is unspecified. Carrier extraction checks required string identities, without validating their format.
- Adapters must implement `TelemetrySpan.addLink()`. Normalized span snapshots include carrier-shaped context and parent identities and ordered links.
- Adapters with optional metric or propagation capabilities must carry them through `TelemetryContext.metrics` and `TelemetryContext.propagation` on roots, spans, and extracted parents.

### Added

- Opaque string-map carriers and optional `TelemetryPropagation` injection/extraction, with passive root fallback for absent or invalid carriers and shared `NOOP_TELEMETRY_PROPAGATION`.
- Initial `SpanOptions.links` and late `span.addLink()` with context targets and optional attributes, including settled target spans and extracted remote parents.
- Optional `TelemetryMetrics` counters, up-down counters, and histograms with boundary hints and exemplar contexts, plus shared `NOOP_TELEMETRY_METRICS` instruments.
- Optional context capability members, populated by the no-op and in-memory adapters and checked by adapter conformance.
- `NOOP_TELEMETRY_CONTEXT` is typed as `TelemetrySpan`, matching the shared inert span it provides.
- Metric schema definitions and `createTypedMetrics()` with exact instrument names, kinds, and required/optional low-cardinality attributes.
- In-memory propagation across processes, link and measurement snapshots, and adapter conformance cases for propagation, links, and optional metrics.
- `StoredSpan`, `StoredTrace`, and `TelemetryStore` define backend-independent trace discovery, trace retrieval, and metric queries. `@earendil-works/pi-telemetry/render` exports `renderTrace()` for plain-text span trees with attributes, durations, errors, events, and cross-trace links; merged spans are deduplicated by ID and links are never followed.

## [1.3.0] - 2026-10-15

## [1.2.0] - 2026-10-12

## [1.1.0] - 2026-10-07

## [1.0.4] - 2026-10-05

## [1.0.3] - 2026-10-05

## [1.0.2] - 2026-10-04

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

## [0.99.2] - 2026-09-30

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

## [0.85.1] - 2026-09-05

## [0.85.0] - 2026-09-04

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Added

- Added the callback-based telemetry context contract, shared no-op context, deterministic in-memory reference adapter, reusable adapter conformance suite, typed serializable schema utilities, and multi-schema typed span starters with explicit child propagation.
