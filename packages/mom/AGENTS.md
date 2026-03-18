# mom — Slack Bot

Slack bot that delegates messages to the pi coding agent. Runs as a service.

## Structure
```
src/
  main.ts      # Entry point, server startup
  agent.ts     # Pi agent integration — creates and manages agent sessions
  slack.ts     # Slack API client (Bolt framework)
  context.ts   # Conversation context management
  events.ts    # Slack event handlers (messages, reactions, threads)
  store.ts     # Persistent storage for conversations
  sandbox.ts   # Sandboxed execution environment
  download.ts  # File download handling from Slack
  log.ts       # Logging
  tools/       # Mom-specific tools exposed to the agent
```

## Where to Look
| Task | Location |
|------|----------|
| Slack event handling | `src/events.ts` + `src/slack.ts` |
| Agent session config | `src/agent.ts` |
| Add mom-specific tool | `src/tools/` |
| Storage/persistence | `src/store.ts` |
