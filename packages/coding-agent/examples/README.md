# Examples

Example code for the pi-coding-agent SDK, process integration, and extensions.

## CLI integration

[`rpc-client.ts`](rpc-client.ts) uses the typed `RpcClient` to run Pi in a child process, stream events, and wait for the run to settle.

Build the coding-agent package before running it from a repository checkout:

```bash
npx tsx examples/rpc-client.ts "Explain this repository"
```

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers (tool interception, safety gates, context modifications)
- Custom tools (todo lists, questions, subagents, output truncation)
- Commands and keyboard shortcuts
- Custom UI (footers, headers, editors, overlays)
- Git integration (checkpoints, auto-commit)
- System prompt modifications and custom compaction
- External integrations (SSH, file watchers, system theme sync)
- Custom providers (Anthropic with custom streaming, GitLab Duo)

### [plugins/pi-example-plugin/](plugins/pi-example-plugin/)
An experimental plugin package that Pi automatically builds into separate Session-worker and TUI Chord facets.

## Documentation

- [SDK Examples](sdk/README.md)
- [CLI Integration](../docs/cli-integration.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
