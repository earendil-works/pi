# Progress

## Status
- complete

## Next Smallest Step
- mission complete

## Notes
- This mission is spec-approved for a control event: `type: "control"`, `kind: "resume-reset"`.
- The command must require an explicit mission path.
- Verification must include both automated tests and XTUI command injection.
- Fixture missions now exist under `devdocs/missions/mission-reset-control-event/fixtures/` and `packages/coding-agent/test/fixtures/mission-reset-control-event/`.
- Red runner tests now fail as expected: converged history still returns `iterations: 0` and blocked history still returns immediate `blocked` even after an appended control event.
- Mission history parsing now treats `type: "control", kind: "resume-reset"` as a barrier that clears derived blocked/convergence state for later resume attempts.
- `/mission-reset <mission-path>` is now registered, appends a single control event, rejects build-mode missions, and rejects malformed `EXPERIMENTS.jsonl` clearly.
- XTUI verification now passes against the real fixture source copied into a temporary mission directory via the actual CLI entrypoint.
- Final targeted tests and `npm run check` are green.
