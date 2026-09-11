# ExecutionEnv: bounded shell output

**Status:** implemented in production source. The prototype files beside this document are historical evidence; production lives in:

- `packages/agent/src/harness/utils/adaptive-publisher.ts`
- `packages/agent/src/harness/utils/output-capture.ts`
- `packages/agent/src/harness/env/nodejs.ts`
- `packages/agent/src/harness/tools/bash.ts`

The generic `ToolOutput` use of the same publisher remains in `04-tool-output`.

## 1. Problem

The old `Shell.exec()` accumulated complete strings inside `NodeExecutionEnv`:

```ts
stdout += chunk;
stderr += chunk;
```

Bash truncated only after those strings had already been built. `cat 1gb.txt` therefore materialized a gigabyte in the worker before any tool-level bound could help.

Spilling also belongs where bytes originate. If execution is remote, a spill on the worker is inaccessible to the model's `read` and `grep` tools, and creating it after transport would first send the complete gigabyte over the connection.

## 2. Boundary

`ExecutionEnv` now owns:

- a bounded head or tail view;
- complete byte and line totals;
- lazy source-local spill after the view first crosses its limits;
- persistent source-local spill with bounded write-stream backpressure;
- adaptive publication of the latest bounded state;
- a forced final publication before settlement.

It does not return or retain separate `stdout` and `stderr` values. Both pipes feed one arrival-ordered model-visible text view, matching bash and `ToolOutput`; preserving stream styling through tail eviction would require a segmented retained state that the Harness does not expose. Text is folded from updates, and `ShellExecResult` contains only exit and truncation/spill metadata.

Bash owns only command semantics and its model-visible footer. Its old rolling buffer, spill creation, 100 ms throttle, and full-output accumulation are gone. The existing two-second durable checkpoint request remains temporarily until `ToolOutput` owns durable cadence.

## 3. Contract

```ts
interface ShellOutputLimits {
  maxBytes: number;
  maxLines: number;
  retain?: "head" | "tail";
}

interface ShellOutputCaptureOptions {
  limits: ShellOutputLimits;
  spill?: boolean;
}

type ShellOutputTruncation = Omit<TruncationResult, "content">;

interface ShellOutputMetadata {
  truncation: ShellOutputTruncation;
  spillPath?: string;
  lastLineBytes?: number;
}

interface ShellOutputView extends ShellOutputMetadata {
  text: string;
}

type ShellOutputUpdate =
  | { kind: "replace"; output: ShellOutputView }
  | { kind: "append"; text: string; metadata: ShellOutputMetadata }
  | { kind: "slide"; drop: number; text: string; metadata: ShellOutputMetadata }
  | { kind: "metadata"; metadata: ShellOutputMetadata };

interface ShellExecResult extends ShellOutputMetadata {
  exitCode: number;
}
```

`drop` counts JavaScript string code units, matching `slice()`. Updates are ordered. A consumer applies them with `applyShellOutputUpdate()`.

A complete replacement establishes the initial state or recovers when no verified overlap exists. An append carries only a growing suffix. A slide drops a prefix and appends the new suffix. Metadata updates move totals or the spill path without resending text.

The compatibility `executeShellWithCapture()` helper still returns one bounded final view. Its `onChunk` callback receives initial, append, and slide text only; metadata and post-turnover replacements are not mislabeled as new bytes.

## 4. Adaptive publication

`AdaptivePublisher` keeps only the latest dirty state. Intermediate process writes never become a queue of output updates.

Policy is harness-global rather than per tool:

```ts
minIntervalMs = 100;
targetBytesPerSecond = 100 * 1024;
nextDelayMs = max(minIntervalMs, encodedUpdateBytes * 1000 / targetBytesPerSecond);
```

The first dirty state after idle is immediate. Writes received before the deadline collapse into the latest bounded state. One trailing timer guarantees eventual publication. Finalization bypasses the deadline once, still bounded by the retained cap.

The publisher commits its baseline before invoking the consumer. If a consumer applies an update and then throws, finalization cannot emit the same delta twice. The command fails with `callback_error`.

### Workload behavior

| workload | result |
| --- | --- |
| Finishes below cap | immediate initial state, small appends, forced final state |
| Below-cap trickle | isolated writes are immediate; sustained writes are at most 100 ms apart |
| Full-force output after cap | complete turnovers are cap-sized replacements spaced by their encoded size |
| Post-cap trickle | small verified `slide` updates remain responsive; the complete window is not resent |
| Burst then silence | one leading update and one trailing update |
| Error, timeout, or abort | latest bounded state is forced before the error settles |

At a 50 KB cap and 100 KB/s target, repeated complete turnovers settle near two updates per second. Small post-cap slides still use the 100 ms floor.

The rate bound is amortized. An immediate-after-idle update and forced terminal update may each create one cap-bounded burst.

## 5. Capture and spill

`OutputCapture` trims its decoded line-aware working buffer back to twice the byte cap when it exceeds four times the cap. Tail mode drops old text; head mode preserves the original prefix. This amortizes UTF-8 trimming instead of rescanning the retained window for every process chunk.

Spill creation is lazy. Before crossing, the source keeps at most the bounded prefix needed to create a complete archive. On crossing it:

1. pauses stdout and stderr while it creates the file inside the execution environment;
2. opens one persistent append stream with a bounded 8 MB high-water mark;
3. writes the preserved raw prefix and subsequent raw chunks in arrival order;
4. resumes immediately while the writer accepts data;
5. pauses again only when `write()` reports backpressure, then resumes on `drain`.

This avoids both an unbounded promise chain and one async file-open/append cycle per process chunk. A spill create or stream-write failure kills the child and fails execution rather than publishing lossy success.

The spill path is force-published as metadata when it becomes available. Spill writes are awaited before the final output flush.

Node streams remain raw for spill throughput and exact archival bytes. `OutputCapture` uses one streaming `TextDecoder`, so a read boundary cannot split a code point; invalid display control characters are removed only from bounded snapshots, not by scanning the complete raw stream. Line totals count a final unterminated line, and `lastLineBytes` remains exact even when one line exceeds the working buffer.

## 6. Remote execution

When worker and execution environment are colocated, updates are in-process and this publisher primarily bounds capture work. `ToolOutput` remains the downstream event/durability limiter.

When an execution environment is physically remote from its worker, the same bounded updates cross that transport. Full-force output cannot transfer the complete stream: intermediate writes collapse at the source, while the complete stream remains in the source-local spill.

Each real costly boundary gets its own publisher instance. A colocated deployment may bypass transport serialization; a custom tool that bypasses `ExecutionEnv` still passes through the future `ToolOutput` publisher.

## 7. Remaining work

- Move generic custom-tool composition, text retention, event publication, and durable cadence into `ToolOutput`.
- Replace whole `AgentToolResult` progress with Chord operations at that downstream boundary.
- Make memo and output checkpoint persistence one atomic transaction.
- Seed replay from durable output rather than deleting it.
- Put spills in an environment-owned session directory and sweep them after session lifetime plus a crash-retention floor.
- Decide explicit limits for images and structured details; text is bounded, those values are not yet.
- Define raw binary-output behavior. Current shell output remains lossy UTF-8 text.
