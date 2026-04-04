# Agent Prompt Integrity Cleanup

## What

Cleaned up the live user-agent prompt pack in `~/.pi/agent/agents`, added a new `backend` agent, and updated the repo-owned plan-mode execution prompt so execution guidance can route backend work explicitly.

## Why

The live prompts had drifted from the real runtime contracts:
- some agents asked for tools they did not have
- some read-only agents exposed write tools
- the planner compatibility prompt still referenced stale plan locations
- there was no dedicated backend specialist in the live roster or execution prompt

## Changed

- rewrote `memory.md` to match its actual `bash` + `read` tool contract and removed secret-bearing guidance
- rewrote `prometheus.md` into a compatibility prompt aligned with `.pi/plans`, `.pi/drafts`, and `.pi/machines`
- added `subagent` access to `metis` and clarified backend/frontend routing hints
- aligned `frontend.md` with repo React rules around `useEffect` and selective memoization
- expanded `tla-precheck.md` so planning-time `check` and execution-time `build` are handled explicitly
- tightened tool frontmatter for `librarian`, `momus`, `sentinel`, and `tester`
- added `~/.pi/agent/agents/backend.md`
- updated `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` so execution guidance includes `backend`
- added a regression assertion in `packages/coding-agent/test/plan-mode-verification.test.ts`

## Verified by

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-verification.test.ts`
- `npm run check`
