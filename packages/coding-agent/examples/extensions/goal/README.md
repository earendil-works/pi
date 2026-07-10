# Goal Extension

Autonomous multi-turn goal execution for long-running tasks.

## Features

- **Persistent goals**: Goals survive session resume via session entry persistence
- **Auto-continuation**: Agent keeps working until the goal is complete or blocked
- **Esc abort safety**: Pressing Escape pauses the goal instead of losing progress
- **Context injection**: Active goals are injected into each turn's context as structured XML
- **Blocked detection**: Goals are paused after persistent blocking conditions (3+ consecutive turns)
- **Pause/resume/cancel**: Full lifecycle control via `/goal` slash command

## Commands

- `/goal <objective>` - Create a new goal (e.g., `/goal refactor auth to use OAuth`)
- `/goal status` - Show current goal status
- `/goal pause` - Pause the active goal
- `/goal resume` - Resume a paused or blocked goal
- `/goal cancel` - Cancel the current goal

## Agent Tools

- `create_goal` - Create a new autonomous goal (user-requested, long-running tasks only)
- `update_goal` - Mark goal as complete or blocked
- `get_goal` - Check current goal state (status and objective)

## How It Works

### State Machine

Goals transition through a minimal state machine:

```
active → paused → active
active → blocked → active (via resume)
any*   → complete → undefined (transient, emits then clears)
any*   → undefined (via cancel)
```

### Persistence

Goal state is stored as custom session entries (`goal_state` type), using pi's built-in session persistence. When a session is resumed, the goal is loaded and automatically paused to prevent the agent from continuing without confirmation.

### Auto-Continuation

When a goal is active and the agent finishes a turn naturally (`stopReason === "stop"`), a follow-up message is automatically sent to continue working. The agent can call `update_goal(status="complete")` when finished, or `update_goal(status="blocked")` when stuck.

### Context Injection

An active goal injects a structured XML block at the start of each turn with the objective, completion criterion, and behavioral rules. Paused and blocked goals inject a lighter reminder.

## Design

- No external dependencies beyond pi's own packages
- Pure state machine (`goal-mode.ts`) testable in isolation
- Persistence via pi session entries (same mechanism as `todo.ts`)
- No new runtime mechanisms — uses only existing extension APIs
