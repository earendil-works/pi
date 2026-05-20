# Repo-Wide Audit

## Executed In This Pass

- Removed stale TypeScript path aliases for missing packages and broken package subpaths.
- Removed unpublished Bedrock root shim files and an unused test-image generator that kept a native dev dependency alive.
- Tightened package boundaries by adding an explicit `@earendil-works/pi-tui` export map.
- Exact-pinned internal lockstep package dependencies and made the pinned-dependency check enforce them.
- Fixed small async lifecycle leaks: terminal fallback timers, abortable sleeps, and cancellable loader disposal.

## Deferred Findings

- Provider identity, default model, display name, and auth metadata are hand-maintained across `pi-ai` and `pi-coding-agent`. A provider descriptor table should become the single source for env vars, display names, defaults, and CLI docs.
- `models.json` compatibility schemas in `pi-coding-agent` mirror `pi-ai` compat types by hand. The schema should be exported or generated from one source.
- Tool truncation logic exists in both `pi-coding-agent` and `pi-agent-core` and should move to one shared implementation.
- Proxy stream terminal events drop assistant metadata such as response ids, response models, and diagnostics. The proxy event contract should carry a typed final-message patch.
- Several provider test matrices are hand-copied and drift-prone. They should be centralized around capability flags and scenario-specific overrides.
- Some credential-dependent behavior tests silently skip core session and compaction paths. These should move to the faux-provider suite, with real-provider checks kept as explicit smoke tests.
- OAuth refresh currently performs network I/O while holding auth file locks. Refresh should use read-check, network refresh with timeout, then compare-and-write under a new lock.
- Child-process timeout handling in execution and package-manager paths should escalate based on process settlement and apply bounded output capture.
- Large bash output files are written under `/tmp` without lifecycle cleanup. They should move under an agent cache directory with retention.
- Provider `timeoutMs` is not honored consistently by Google, Mistral, and Bedrock providers.
- `AuthStatus.configured` is inconsistent across auth sources. The API should distinguish usable credentials from stored/removable credentials.
- Public tool-call and agent event payloads still expose `any` at JSON boundaries. Introduce JSON value/object types for those contracts.
- Manual probes live under test directories. Convert real regressions to tests and move live diagnostics under a manual scripts area.
