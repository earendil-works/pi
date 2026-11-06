# Performance audit: agent runtime and supporting systems

Date: 2026-11-06  
Repository: `AmirrezaFarnamTaheri/pi`  
Base revision: `4ffe32c6f1a138451162d6772f2723488fa32fad`  
Scope: Static investigation plus isolated, synthetic Node checks. No end-to-end repository profiling was available in the execution environment.

**Read this first:** Code patterns below establish *potential* or algorithmically evident bottlenecks, not measured production p95s. The PR is incomplete relative to this audit: workspace CI and profiling have not been run locally, so the first full run is the PR's own CI.

## Finding inventory

| ID | Priority | Hotpath | Evidence | PR status / next action |
| --- | --- | --- | --- | --- |
| P01 | High | Full transcript TUI work per redraw | `packages/tui/src/tui-main-screen.ts` `doRender` calls `render(width)` and diffs the resulting entire buffer; `packages/tui/src/layout.ts` lays out full scroll children | **Open:** structural viewport/incremental layout redesign; benchmark 100/1k/10k messages |
| P02 | High | Session discovery JSONL parsing | `packages/coding-agent/src/core/session-manager.ts` `buildSessionInfo` streams and parses every record and builds `allMessagesText` | **Partial:** bounded stat-validated cache for unchanged files; durable metadata/search index still needed |
| P03 | High | stdout spill backpressure | `packages/coding-agent/src/core/tools/output-accumulator.ts` `append` writes without awaiting drain; `bash.ts` connects both child pipes | **Implemented, unverified:** backpressure pauses pipes; test large stdout/stderr, early shell exit, slow filesystem and cancellation |
| P04 | High | Unsafe user regex search | `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts` `new RegExp(pattern, "i")` and `.test(session.allMessagesText)` run synchronously on the TUI event loop | **Implemented, monorepo unverified:** async picker now debounces, cancels, and times out worker regex searches; catastrophic-pattern regression, in-flight cancellation, and integration tests added |
| P05 | High | Chord live query invalidation | `packages/chord/src/store/live-query.ts` `refreshOf` chooses all subscribers of written tables, `QueryRefresh.#rerun` awaits all queries | **Open:** keyed/predicate-based invalidation and shared query execution; benchmark queries-per-write |
| P06 | Medium | Synchronous session writes | `packages/coding-agent/src/core/session-manager.ts` `_persist` uses `writeFileSync`/`appendFileSync` | **Open:** needs durability/ordering-compatible async writer or worker and crash-recovery tests |
| P07 | Medium | Repeated sorted progress and path canonicalization | `session-manager.ts` sorts progressive prefixes, `session-selector.ts` canonicalizes paths repeatedly | **Partial:** incremental insertion and per-tree canonical-key cache; test directory-scanning throughput |
| P08 | Medium | Progress promise retention | `packages/agent/src/agent-loop.ts` previously collected every `onUpdate` promise until tool completion | **Implemented, unverified:** unresolved-only promise tracker and regression tests |
| P09 | Medium | Tool-state diff schema allocations | `packages/agent/src/agent-loop.ts` `declareToolChanges`; `packages/ai/src/utils/transcript.ts` `declarationsEqual` | **Partial:** removes redundant declaration clones and comparisons; replay still scans message history |
| P10 | Medium | Bulk file-index N+1 reads | `packages/chord/src/node/app/files-index.ts` `#movedMarks`, `#released` per-row `get` | **Implemented, unverified:** chunked `inArray` queries and integration test |
| P11 | Medium | Web transcript virtual metadata rebuild | `apps/p2/src/web/Chat.tsx` `transcriptRows` maps all items; `use-chat-scroll.ts` `prepare` and `virtual-list.ts` rebuild offsets | **Partial:** append-only offsets fast path; `transcriptRows` and prefix identity checks still scan all rows |
| P12 | Medium | Unbounded generic event queue | `packages/ai/src/utils/event-stream.ts` `push` appends without capacity or backpressure | **Partial:** agent event producers now await active-consumer capacity; synchronous `push()` and result-only streams remain intentionally unbounded to preserve existing API semantics |
| P13 | Medium | Mixed tool-batch serialization | `packages/agent/src/agent-loop.ts` previously serialized all calls if one tool was sequential | **Implemented, unverified:** parallel groups separated by sequential barriers; preserve result order and abort semantics |
| P14 | Low | Streaming Markdown repeatedly lexed | `packages/tui/src/components/markdown.ts` token cache keyed by entire source string | **Open:** incremental streaming token parser with fence/reference correctness |
| A01 | Medium | Agent steering/follow-up FIFO copies tail | `packages/agent/src/agent.ts` `PendingMessageQueue.drain` previously used `slice(drained.length)` | **Implemented:** head-index FIFO with periodic compaction and isolated 10k-message FIFO test |
| A02 | Medium | Agent event listeners serial per delta | `packages/agent/src/agent.ts` `processEvents` awaits each listener on every update | **Open:** measure subscriber costs; sequencing is intentional, so do not parallelize callbacks without contract tests |
| A03 | Medium | Agent event stream copy and queue churn | `packages/agent/src/agent-loop.ts` wraps streamed messages in spread copies and awaits downstream emit; `packages/ai/src/utils/event-stream.ts` stores queued events | **Partial:** producer failure now rejects awaiting result() and wakes iterator consumers; still profile provider delta rates, allocation/GC and slow-consumer behavior |
| A04 | Medium | Repeated conversation projection per provider request | `packages/coding-agent/src/core/agent-session.ts` `_installAgentRequestProjection` calls `buildSessionProjection`; model routing/compaction may compute another projection | **Open:** revision-based projection cache with mutation invalidation and multi-branch tests |
| A05 | Medium | Agent loadout checks replay full history | `packages/agent/src/agent-loop.ts` `declareToolChanges` calls `getCurrentTools(context.messages, baseline)` each turn | **Partial:** eliminated history concatenation and redundant schema cloning; a full scan remains until incremental loadout state can respect in-place edits |
| A06 | Medium | Agent pending-tool set copied per event | `packages/agent/src/agent.ts` `processEvents` creates `new Set(pendingToolCalls)` on start/end | **Reviewed, left open:** the copy keeps each observer's `pendingToolCalls` snapshot stable and costs O(pending) per start/end, which only matters with hundreds of concurrent calls; benchmark before changing |
| A07 | Low–Med | Session recovery scans and projection rebuilds | `packages/coding-agent/src/core/agent-session.ts` `_findPersistedMessageEntryId` constructs `[...getBranch()].reverse()` and may build projection | **Partial:** the branch scan no longer copies and reverses the branch; the projection fallback and an indexed entry-id map remain open |
| A08 | Medium | Durable scheduler sorting idle states | `packages/durable/src/harness/scheduler.ts` sorts `#idleOrder` on candidate selection | **Requires profiling:** heap/ordered queue may help at high task counts; workload-dependent |
| A09 | Low–Med | React tool argument serialization | `apps/p2/src/web/Chat.tsx` contains repeated `JSON.stringify` of tool args during render | **Requires profiling:** memoize only where props immutable and updates accounted for |
| A10 | Low–Med | Large-batch argument spread limit | `apps/p2/src/web/virtual-list.ts` append path initially used `push(...keys)` | **Implemented, unverified:** iteration supports 150,000-key regression |

## Isolated checks performed

- Standalone Node FIFO queue test with 10,000 enqueues/drains: **PASS**. This exercised the extracted queue implementation, not the full package.
- Synthetic FIFO throughput at 1k/10k/30k: replacing repeated `slice(1)` with head-index draining improved times substantially in this environment; timings fluctuate and are not production measurements.
- Synthetic progressive session-sort throughput at 1k/10k/30k: incremental binary-search insertion plus occasional slice avoided repeated full-prefix sorting. This is not a file-system workload or end-to-end picker benchmark.
- Standalone tool-state comparison test: **PASS** after changing comparison to compute each same-name pair only once.
- Isolated Node event-stream backpressure tests: **4 PASS** for slow consumers, result-only callers, stream closure, and multiple iterators. Tests use a standalone replica of the stream implementation; full workspace Vitest remains unrun.
- Isolated agent queue and progress-update tracker tests: **4 PASS** (10,000-message FIFO and resolved promise retention). Segmented tool replay tests: **2 PASS**, including a 100,000-message history. These also use standalone replicas, not the compiled monorepo.
- **2026-11-06:** Six local Node regex-worker prototype tests passed, including catastrophic backtracking timeout, in-flight abort and multi-batch ordering. The TypeScript integrated worker tests were committed to the repository but could not be run here.
- An agent-loop failure regression was added so rejected execution settles `result()` instead of leaving callers hanging. The new Vitest tests remain unverified.

## Review follow-up (2026-11-07)

- Rebased onto upstream `main` (22 commits) without conflicts.
- Verified each CodeRabbit finding against the current code. Fixed since the review: shared-estimate invalidation in the p2 append path, content-validated and copy-isolated session cache, abort-aware stream publication, fail-fast `ToolUpdateTracker.drain()`, awaitable tool updates, root-normalized declaration comparison, abortable bash output waits, `finish`-aware drain, selection preservation and progress-based timeout in the regex search. Added in this pass: the barrier, tracker, held-`onData` and selector tests, docstrings, and removal of the redundant p2 CI build.
- Replaced two constructor parameter properties (`ToolUpdateTracker`, `SessionInfoCache`) with explicit fields; `erasableSyntaxOnly` rejects them.
- Checks run locally: Node strip-only transform of all changed TypeScript files, and Node checks of the tracker, queue and event stream. `npm run check` and `./test.sh` could not be run (no dependency install in the authoring environment).

## Validation required before merge

1. **Workspace correctness:** `npm ci --ignore-scripts && npm run build && npm run check && npm test`; also run `npm --prefix apps/p2 test` or the focused CI job. Run the new unit tests in isolation to diagnose failures.
2. **TUI:** `npm run profile:tui`; compare 100, 1,000 and 10,000 message transcripts for p50/p95 frame duration, event-loop delay, CPU time, peak RSS and GC.
3. **Sessions:** 100, 1,000 and 10,000 JSONL sessions, varying length and edit patterns; compare cold scan, warm scan, search keystroke latency and peak RSS.
4. **Shell output:** 64–256 MiB bursty stdout and stderr, disk throttling, inherited pipe handles, cancellation and exit-before-drain; monitor write queue size and byte-for-byte preservation.
5. **Agent runtime:** 1k–100k tool updates, 1k–30k queued messages, 10/100/1k concurrent tool calls and 100/1k/10k message turns; capture event-loop delay, GC, heap, listener latency, and tool declaration allocation.
6. **Chord:** 1/10/100/1k active live queries per table; measure query statements/write and transaction latency. Exercise moves/deletes across 100–10k distinct blobs with reference sharing.
7. **Web:** append, prepend, replace, width change and measured-height invalidation at 1k and 10k transcript rows.

**No CI workflow result was available when this audit was recorded.** Do not interpret a lack of failure checks as passing checks.
