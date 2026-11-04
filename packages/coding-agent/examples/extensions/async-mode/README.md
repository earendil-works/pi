# Optional async mode

In Async mode, ordinary input bypasses the busy main agent and goes directly to a read-only answer call. When the main agent is idle, input follows Pi normally. The only public command is `/mode`, which offers **Default** and **Async**.

## Install and use

Copy the complete `async-mode` directory into `~/.pi/agent/extensions/`. Finish current work and reopen Pi or use `/reload`. Enter `/mode`, select **Async**, and type normally. New sessions start in Default. Do not load this copy together with the independently installed `pi-async-mode` package.

Each busy-time question makes one answer call using the selected Pi model and a snapshot of the main conversation. There is no model-based routing, automatic steering, clarification menu, dependency scheduling or child-session creation in the question path. Answers are read-only and appear automatically. Other side questions are not copied into the request. UI messages use English; answers follow the user's language.

Slash commands, extension messages and explicit follow-up delivery keep their native behavior. Default mode preserves Pi's normal input handling. An idle main agent handles new input normally even if previous side-question records exist.

## Context and lifetime

The answer receives the question and attachments plus a bounded snapshot of recent main conversation text and any partially streamed main answer.

Each answer records its original question, request/session IDs, start and finish times, state and result. Answers appear immediately through Pi UI notifications. Active questions show stage and elapsed time above the editor. Up to four questions may run concurrently; a slow answer does not serialize later answers. Additional questions are returned to the editor for retry.

The main agent receives the last eight attributed result records at its next model call, with an explicit indication that they have already been displayed. It can read complete records with the model-only `async_dialogue_read` tool. Results are reference data, not new instructions to execute an action. Returning a side answer does not force a new main-agent turn.

The selected model and authentication come from Pi's model registry. There is no provider-specific adapter or separate routing model. The simple API requests its normal reasoning-off behavior, which depends on the host provider's support. Calls may still be slow. Each side answer has a 180-second deadline; a timeout reports failure and releases its slot. Main-agent work is unaffected.

Selecting Default does not cancel an already accepted answer. Reloading, switching sessions or exiting aborts session-owned requests. Unfinished historical requests are cancelled on restore, including old routing/dependency records, and are not automatically replayed. Saved histories remain in the parent session.

The main agent's existing `async_start`, `async_status` and `async_cancel` tools remain available for its own complex background work. Those workers may use tools and share files; they are separate from read-only side questions.

## Validation

From `packages/coding-agent`, with repository dependencies prepared:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/async-mode-runtime.test.ts test/async-mode-executor.test.ts test/async-mode-model-request.test.ts test/suite/async-mode.test.ts test/suite/async-dialogue.test.ts
```

Tests use the faux provider and local subprocesses without real model calls. The same runtime sources are distributed separately as the `pi-async-mode` package.
