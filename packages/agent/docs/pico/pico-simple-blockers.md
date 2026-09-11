# Pico implementation state

## Authority

[`pico-simple-handoff.md`](pico-simple-handoff.md) is the sole normative implementation specification.
Read it completely before implementation. Other Pico documents and prototypes are historical inputs only.

Astra reviewer `e5771f` reviewed the complete rewritten specification through multiple iterations and
returned explicit `APPROVED`. Keep the reviewer available for implementation follow-up.

## Git state

- Branch: `pico`
- Branch base when created: `f3c672245`
- No production implementation has started.
- The documentation preservation commit includes the pre-implementation Pico design cleanups and the
  approved simple handoff.
- Implement and commit one small work package at a time for user review.

## Next action

Start WP1 from `pico-simple-handoff.md`: core types and kind witnesses under
`packages/agent/src/harness/pico/`, including compile-time tests. Delegate implementation with provider
`openai-codex`, model `gpt-5.6-sol`. Run the focused test and full `npm run check`, then use retained Astra
for review. Commit only WP1 files after the package boundary is approved.

## Adopted core

The harness owns `pending -> running -> terminal`. Task input is immutable typed JSON. A checkpoint is an
optional full replacement with `phase: string`. Execute/recover return typed terminal closures applied
atomically with outcome and scratch retirement. Cancellation is mark, revoke writes, signal, join, fresh
abort, then a restricted abort closure.

`turn: true` is a trusted replaceable task-kind capability. Background is independent because speculative
manual collapse is background plus turn. Non-turn tasks use limited transactions and `accept`/`write`;
turn tasks may append model-affecting entries directly. Every missing live kind becomes orphaned at open.
Input groups belong to built-in generation/post_tools. V1 is job-first and excludes arbitrary unfinished
promise adoption. Tool/job output sharing remains gated.
