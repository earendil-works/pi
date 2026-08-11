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
/goal <objective> [--tokens N] [--cost N]   Set or replace the goal (flags may appear anywhere)
/goal                                       View the current goal and status
/goal pause                                 Pause work on the goal
/goal resume                                Resume a paused, waiting, or budget-limited goal
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
- Navigating the session tree reloads the goal state for the selected branch
  without auto-continuing, so switching branches is always an inspection action.
- When a goal exists, the footer/status bar, editor widget, and terminal title
  show `GOAL MODE`, `GOAL PAUSED`, `GOAL COMPLETE`, or `GOAL BUDGET LIMITED`.
  The status bar shows `mode: build` with no goal and `mode: goal` while a
  goal exists, so normal and goal modes are visually distinct. When an active
  goal stops because the last turn made no tool calls, the label becomes
  `GOAL MODE (WAITING)`. When a budget is set, the widget shows usage consumed
  so far (for example `Budget: tokens 50/100`).
- Typing `/goal` in the interactive editor shows the command usage hint and
  completes the `pause`, `resume`, and `clear` subcommands.
- The active goal is injected into every model request, including current
  budget usage when a budget is set. The model is told to verify progress
  against concrete evidence and to call `complete_goal` only after the
  objective is satisfied.
- The model can only request completion through `complete_goal`. Pause, resume,
  and clear are user-only commands. Completion evidence must be at least 20
  characters describing concrete verification (command output, test results,
  or file changes), so the model cannot close a goal with a bare status word.
- `/goal view` shows budget usage in any status, so you can see what was
  consumed after a pause or budget stop.
- `/goal pause` and `/goal clear` abort any in-flight autonomous work before
  switching state, so the UI returns to the paused or normal mode immediately.
- Setting a new goal while the agent is streaming also aborts the current run
  and starts the new goal after the run settles.
- Automatic continuation is deduplicated: only one continuation is queued at a
  time, and it is reset when the next run starts.
- Automatic continuation happens only when the goal is active, the agent is
  idle, no user input is queued, the budget is not exhausted, and the previous
  turn actually used a tool. A turn with no tool calls stops the loop instead
  of spinning.
- Budget exhaustion transitions the goal to `budget_limited` and stops work. It
  is not treated as completion. `/goal resume` starts the budget over from the
  current usage and continues the same objective.

## Notes

This is an extension, not a separate CLI run mode. In interactive and RPC
sessions the extension keeps the session alive while it works. For unattended
use, run pi in a terminal session that stays open (for example `tmux`) or build
a small wrapper around the pi SDK.
