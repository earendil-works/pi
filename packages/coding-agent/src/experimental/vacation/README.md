# vacation

A durable vacation planning agent with a TUI, built on `@earendil-works/pi-durable`. It is a copy of the durable coding
agent in [`../durable`](../durable) with the coding tools and pi's coding prompt replaced by a vacation planner. It only
looks like a coding agent because it reuses pi's interactive TUI components.

From a pi checkout, after `npm install` and `npm run build`:

```bash
node packages/coding-agent/src/experimental/vacation/main.ts
node packages/coding-agent/src/experimental/vacation/main.ts --continue
```

Without a build, preload the source resolver so the workspace packages load from `src` instead of `dist`:

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts packages/coding-agent/src/experimental/vacation/main.ts
```

A new session starts with pi's default model and thinking level from `settings.json`. `--continue` opens the newest
session for the current directory. Sessions live under
`~/.pi/agent/experimental/vacation-sessions/<cwd-hash>/<session>/session.sqlite`. Log in with pi itself; credentials are
shared.

## What it shows

- **Background subagent:** the `research` tool starts a subagent in its own conversation and returns at once. A
  background task delivers the request and posts the subagent's report back to the main conversation as a new message,
  so you keep chatting with the main agent while the research runs.
- **Parallel durable tool calls:** the subagent's `search` calls run in parallel, each as its own task in the task
  panel. The results are canned; each topic takes a different time.
- **Recovery:** `search` is safe to rerun. Kill the process while a search runs and start it again with `--continue`:
  finished searches are kept, the unfinished one runs again, and the report still arrives. Request IDs keep a restart
  from sending the request or the report twice.
- **Everything else from the durable coding agent:** steering, follow-ups, `/agents`, `/compact`, `/tasks`, `/model`.

## Try it

1. "Plan a weekend in Vienna for two. Hand the research to a subagent."
2. While the searches run, ask the main agent something else.
3. Ctrl+C while only the trains search is left, then start again with `--continue`.
4. `/agents` to watch or steer the subagent, `/agents` again to go back to main.

## Layout

| file | role |
| --- | --- |
| `vacation.ts` | the vacation extensions: `search`, `research`, the report task, and the prompt |
| `main.ts` | arguments, open, run, close |
| `sessions.ts` | session directories and the lock |
| `harness-setup.ts` | HTTP setup, settings, the registry, the initial model |
| `runtime.ts` | Harness and the plain `DurableView` and `DurableController` |
| `tui.ts` | rendering with pi's interactive components |
