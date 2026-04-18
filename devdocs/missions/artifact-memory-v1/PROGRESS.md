# Progress

## Status
- complete

## Next Smallest Step
- None. Mission complete.

## Notes
- Architecture is approved: one authoritative append-only memory substrate under `~/.mu/wiki/`, one derived projection per workspace, workspace-first retrieval, and explicit memory tools for user-directed memory interactions.
- Milestone `store-and-projection-core` is green with evidence in `devdocs/missions/artifact-memory-v1/evidence/`:
  - targeted store/projection tests pass
  - projections rebuild from authoritative entries alone
  - the real CLI startup surface shows the loaded workspace memory projection
- Automatic memory writes are intentionally narrow in v1: only completed `edit`, `apply_patch`, `write`, and artifact-producing `bash` executions are eligible.
- Milestone `artifact-triggered-writes` is green with evidence in `devdocs/missions/artifact-memory-v1/evidence/`:
  - targeted trigger/runtime tests pass
  - diff/assertion evidence shows writes only for `write`, `edit`, `apply_patch`, and artifact-producing `bash`
  - XTUI evidence shows the visible terminal surface matches the narrow trigger policy
- The red suite for milestone `memory-tools-and-fresh-session-retrieval` now fails for the intended reasons:
  - resolved: `memory_store`, `memory_search`, and `memory_read` are now registered and tested
  - resolved: fresh `mu exec --json` retrieval uses the memory-tool boundary and returns the stored launch code in a fresh session
- Conversational memory automation and LLM classifier-based store/skip decisions are out of scope for this mission.
- Validation must prove persistence through fresh `mu exec --json` sessions rather than only through internal unit tests.
- Exact tool-call order is not part of the validation contract, but explicit user-requested storage must use the memory-tool boundary once implemented.
