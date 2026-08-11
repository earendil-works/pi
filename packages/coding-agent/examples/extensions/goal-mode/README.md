# Goal Mode Extension

A self-contained long-running goal mode for pi. It keeps one objective attached
to the current session, persists it across resume/fork/compaction, and continues
working autonomously until the objective is verified, paused, cleared, or the
budget runs out.

## Usage

```bash
pi --extension examples/extensions/goal-mode/index.ts
```

Commands:

```text
/goal <objective> [--tokens N] [--cost N]   Set or replace the goal
/goal                                       View the current goal and status
/goal pause                                 Pause work on the goal
/goal resume                                Resume a paused goal
/goal clear                                 Clear the goal
```

Startup flag:

```bash
pi --extension examples/extensions/goal-mode/index.ts \
  --goal "Fix the flaky suite" \
  --goal-budget-tokens 100000 \
  --goal-budget-cost 5
```

## Behavior

- The goal is stored as a custom session entry, so it survives resume, fork,
  and compaction. The active branch's most recent goal entry wins.
- When a goal exists, the footer/status bar, editor widget, and terminal title
  show `GOAL MODE`, `GOAL PAUSED`, `GOAL COMPLETE`, or `GOAL BUDGET LIMITED`.
  The status bar shows `mode: build` with no goal and `mode: goal` while a
  goal exists, so normal and goal modes are visually distinct.
- Typing `/goal` in the interactive editor shows the command usage hint and
  completes the `pause`, `resume`, and `clear` subcommands.
- The active goal is injected into every model request. The model is told to
  verify progress against concrete evidence and to call `complete_goal` only
  after the objective is satisfied.
- The model can only request completion through `complete_goal`. Pause, resume,
  and clear are user-only commands.
- `/goal pause` and `/goal clear` abort any in-flight autonomous work before
  switching state, so the UI returns to the paused or normal mode immediately.
- Automatic continuation happens only when the goal is active, the agent is
  idle, no user input is queued, the budget is not exhausted, and the previous
  turn actually used a tool. A turn with no tool calls stops the loop instead
  of spinning.
- Budget exhaustion transitions the goal to `budget_limited` and stops work. It
  is not treated as completion.

## Notes

This is an extension, not a separate CLI run mode. In interactive and RPC
sessions the extension keeps the session alive while it works. For unattended
use, run pi in a terminal session that stays open (for example `tmux`) or build
a small wrapper around the pi SDK.
