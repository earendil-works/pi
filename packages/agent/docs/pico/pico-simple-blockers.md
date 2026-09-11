# Pico implementation state

## Authority

[`pico-simple-handoff.md`](pico-simple-handoff.md) is the sole normative implementation specification.
Read it completely before implementation. Other Pico documents and prototypes are historical inputs only.

The original specification and WP1 received delegated review. Peer review then identified and resolved
TaskOutput contract inconsistencies in JSONL replay, mutation failure handling, watch reconnection,
kind replacement and generation partial state.

## Git state

- Branch: `pico`
- Branch base when created: `f3c672245`.
- WP1 implements compile-time declarations under `packages/agent/src/harness/pico/` with focused compile
  coverage.
- Implement and commit one small work package at a time for user review.

## Next action

Review the WP1 commit, then begin WP2 only after explicit user approval. WP2 is the mutation algebra and
`MemoryStorage`; follow its prerequisites, acceptance criteria and one-commit boundary in the handoff.

## Adopted core

The harness owns `pending -> running -> terminal`. Task input is immutable typed JSON. A checkpoint is an
optional full replacement with `phase: string`. Execute/recover return typed terminal closures applied
atomically with outcome and scratch retirement. Cancellation is mark, revoke writes, signal, join, fresh
abort, then a restricted abort closure.

`turn: true` is a trusted replaceable task-kind capability. Background is independent because speculative
manual collapse is background plus turn. Non-turn tasks use limited transactions and `accept`/`write`;
turn tasks may append model-affecting entries directly. Every missing live kind becomes orphaned at open.
Input groups belong to built-in generation/post_tools. V1 is job-first and excludes arbitrary unfinished
promise adoption. Shared TaskOutput storage/runtime/watch foundations are settled; concrete tool/job
payloads, bounded capture/spill policy and model projection remain gated.
