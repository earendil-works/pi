# Architecture Proposal

## Summary

Add a dedicated `mu exec` subcommand and make it the canonical non-interactive machine interface.

Implement `mu exec --json` as a stable JSONL protocol on `stdout`, using an adapter layer that maps Mu runtime events into a public exec event schema. Do not expose raw internal `AgentEvent` names directly.

## Proposed Boundaries

- CLI boundary:
  - New canonical surface: `mu exec`
  - New machine mode: `mu exec --json`
  - Legacy `--print` and `--mode json` are not the target surface for this mission.
- Runtime boundary:
  - Keep existing agent/runtime internals intact where practical.
  - Add a dedicated exec-mode adapter between internal events and public JSONL output.
- Output boundary:
  - `stdout` is reserved for final text in human exec mode and JSONL only in `--json` mode.
  - diagnostics and warnings go to `stderr`.

## Key Abstractions

- `exec` CLI entrypoint
- stable public exec event schema
- event adapter / processor that maps Mu runtime events to public exec events
- output writer that enforces stdout/stderr discipline

## Tradeoffs

- Chosen:
  - stable machine contract first
  - exhaustive event coverage now rather than a minimal subset
  - dedicated `mu exec` boundary rather than reusing legacy flags
- Rejected:
  - exposing raw internal runtime events directly
  - mixing human-readable output with machine output on stdout
  - leaving event normalization implicit in `main.ts`

## What We Are Optimizing For

- stable machine-readable contract
- additive future extensibility
- grep-friendly event names and explicit lifecycle semantics
- low ambiguity in verification

## Alternatives Considered

- Extend `--mode json` in place
  - rejected because the public contract would remain tied to unstable internal event shapes
- Ship only a small subset of events
  - rejected because the user asked for exhaustive coverage and stable machine contract first

## Approval Captured

- Boundaries: hard migrate to `mu exec`
- Abstractions: approved
- Tradeoffs: be exhaustive
- Priorities: stable machine contract first
