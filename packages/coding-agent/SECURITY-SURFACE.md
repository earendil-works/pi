# Security Surface

Inventory of every file that carries this fork's closed-network security behavior
(`secureMode` provider allowlisting, outbound-call suppression), what each one enforces,
its test coverage, and the upstream tag it was last verified against.

**Purpose**: a merge with zero textual conflicts is not proof the security semantics
survived — `model-registry.ts` proved that during the v0.84.2 sync (upstream rewrote it
into a thin facade over a new `ModelRuntime`; the enforcement had to be re-ported by
hand). This table is what a human checks after every upstream sync, and what Part 2's
automation (`scripts/upstream-sync.mjs`) parses to decide whether a sync can proceed
unattended or must stop for review.

**How to update this file after a sync**: for each row, run its test file(s) in
isolation, and separately read `git diff upstream/<prev> upstream/<new> -- <file>` for
the file itself — don't rely on the merge having reported a clean auto-merge. Bump
"Last verified" to the new upstream tag only after both checks pass.

## Enforcement files

| File | Enforcement point(s) | Test file(s) | Last verified |
|---|---|---|---|
| `src/core/model-registry.ts` | Facade over `ModelRuntime`; `isProviderAllowed()`, `getAvailable()`, `registerProvider()` all delegate to the runtime. `secureMode` defaults to `true` in `setSecureMode()`. | `test/model-registry.test.ts` | v0.84.2 |
| `src/core/model-runtime.ts` | Actual enforcement lives here post-sync: `isProviderAllowed()` (line ~418) checks `providersWithCustomBaseUrl`; `getAvailable()`/model listing filtered through it (~426, ~451); `registerProvider()` throws `SECURE_MODE_PROVIDER_ERROR` for disallowed providers (~631, ~789, ~800). Also gates `refresh()` behind the closed-network ceiling (`modelNetworkEnabled`) so `SPI_OFFLINE` can't be bypassed by a caller passing `allowNetwork: true`. | `test/secure-mode.test.ts` (`describe("request gate")`, `describe("extension provider registration")`, `describe("closed-network refresh ceiling")`) | v0.84.2 |
| `src/core/security-policy.ts` | Defines `SECURE_MODE_PROVIDER_ERROR`, the shared error message thrown by every registration-gating call site. New file introduced during the v0.84.2 re-port; no dedicated test file — covered indirectly via the registration-throw assertions in `test/secure-mode.test.ts`. | (indirect — see `model-runtime.ts` row) | v0.84.2 |
| `src/core/model-resolver.ts` | `resolveCliModel()` gates the resolved model through `modelRuntime.isProviderAllowed()` (single shared check, line ~408) before returning it — consolidates what was previously 4 separate unguarded return paths (Step 0 Finding A). | `test/model-resolver.test.ts` | v0.84.2 |
| `src/core/settings-manager.ts` | `getSecureMode()` defaults to `true` when unset in `settings.json` (line ~774); this is the value `ModelRegistry`/`ModelRuntime` construction reads at startup. | `test/settings-manager.test.ts`, `test/settings-manager-bug.test.ts` | v0.84.2 |
| `src/main.ts` | Forces `SPI_OFFLINE=1` and `SPI_SKIP_VERSION_CHECK=1` unconditionally at startup (line ~575-576), regardless of any flag a caller passes — the ceiling both `package-manager.ts`'s and `tools-manager.ts`'s offline checks and `version-check.ts`'s skip check read from. | `test/main-outbound-suppression.test.ts` | v0.84.2 |
| `src/utils/tools-manager.ts` | `isOfflineModeEnabled()` (reads `SPI_OFFLINE`) gates the `fd`/`rg` binary download path in `ensureTool()` (line ~347) — skips with a warning instead of downloading when offline. | `test/tools-manager.test.ts` (`describe("ensureTool")`) | v0.84.2 |
| `src/core/package-manager.ts` | Local `isOfflineModeEnabled()` (duplicate of the tools-manager helper, not shared) gates extension install/update network fetches at multiple call sites (lines ~1070, ~1165, ~1250, ~1281, ~1460, ~1511) — `update --extensions` becomes a no-op under `SPI_OFFLINE`. | `test/package-manager.test.ts`, `test/package-manager-ssh.test.ts` | v0.84.2 |
| `src/modes/interactive/interactive-mode.ts` | Guards the background model-catalog refresh in `run()` behind `process.env.SPI_OFFLINE` (line ~1054) so interactive startup doesn't reach the network when offline. | Covered via `test/secure-mode.test.ts`'s `ModelRuntime.refresh()` ceiling tests, not a dedicated interactive-mode test — see note below. | v0.84.2 |
| `src/core/extensions/runner.ts` | `bindCore()`'s `registerProvider`/`unregisterProvider` bindings delegate to `ModelRegistry.registerProvider()` (lines ~356-403) — no independent enforcement here, it inherits the gate from `model-runtime.ts`. (Corrects an earlier overstatement in `CLAUDE.md`/`requirements.md` that described this as an independent enforcement point — see PI-18.) | `test/extensions-runner.test.ts` | v0.84.2 |
| `src/cli/args.ts` | Not an enforcement point — documents the user-facing `--offline` flag and `SPI_OFFLINE`/`SPI_SHARE_VIEWER_URL` env vars (lines ~309, ~420-422). Included in this manifest because it's the surface a user reads to discover the controls above exist. | `test/args.test.ts` | v0.84.2 |
| `src/config.ts` | Not an enforcement point — `getShareViewerUrl()` builds the `/share` gist URL from `SPI_SHARE_VIEWER_URL`; the refusal itself happens via the `SPI_OFFLINE` ceiling `main.ts` sets, same pattern as tools/package manager. | (none dedicated) | v0.84.2 |

**Gap found during this audit**: `src/modes/interactive/interactive-mode.ts`'s offline
guard (line ~1054) has no test that exercises `InteractiveMode` directly — coverage is
indirect, via `ModelRuntime.refresh()`'s own ceiling test. Functionally correct today
(475/475 tests green across every row above), but a future refactor of
`interactive-mode.ts` could silently drop the `SPI_OFFLINE` check without any test
failing. Worth a follow-up issue if this manifest gains teeth in Part 2's automation.

## Frozen from sync

These packages are **not** touched by upstream syncs going forward — upstream itself
recommends forks keep maintaining them after removing them
(`0ed0d4343` for mom/pods, `b141e1fa2` for web-ui: *"People should check out pi-chat ...
or use an older commit for mom and fork"*). A sync that finds these deleted or missing
from the workspace must restore them explicitly, not treat the deletion as legitimate.

| Package | Frozen since | Why |
|---|---|---|
| `packages/mom` | v0.70.6 sync batch | Removed upstream at `0ed0d4343`; fork continues maintaining it. |
| `packages/pods` | v0.70.6 sync batch | Same commit, same rationale. |
| `packages/web-ui` | v0.80.0 sync batch | Removed upstream at `b141e1fa2`. |

## New packages adopted without triage (open item)

`client`, `evals`, `protocol`, `server`, `session-backends`, `telemetry` all landed in
the v0.84.2 sync and are present in the workspace today. None of them went through the
triage this manifest's process calls for — in particular `telemetry` should be read for
outbound-reporting behavior before being trusted by default. Tracked as PI-16.
