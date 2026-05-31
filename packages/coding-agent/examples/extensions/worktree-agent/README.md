# Worktree Agent Extension

Launch a child `pi` agent in a fresh Git worktree. This gives each delegated task its own branch and working directory so the parent checkout is not modified while the child agent works.

This is worktree isolation, not a security sandbox or container. Commands still run with the current user's permissions.

## Usage

```bash
pi -e ./packages/coding-agent/examples/extensions/worktree-agent
```

The extension registers:

- `worktree_agent` tool: lets the model delegate a task to an isolated child agent.
- `/worktree-agent <task>` command: launches a child agent from the editor.
- `--worktree-agent-root <dir>` flag: changes the worktree storage directory.
- `--worktree-agent-remove` flag: removes worktrees after child agents finish.

By default, worktrees stay under `~/.pi/agent/worktrees/` so you can inspect, test, commit, merge, or remove them manually.

Example prompt:

```text
Use a worktree agent to prototype replacing the config parser, then summarize the branch and files it changed.
```
