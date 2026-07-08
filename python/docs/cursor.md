# Cursor provider transport

The TypeScript `packages/ai` tree includes an optional Connect/H2 protobuf proxy for Cursor (`providers/cursor/proxy.ts`). That path targets OpenAI-compatible local proxying with API-key auth.

The Python port intentionally uses the **Cursor CLI bridge** instead:

- Model discovery: `agent models` subprocess (`pi_mono.ai.cursor_agent`)
- Streaming: `agent --print --output-format stream-json`
- Auth: `agent login` / subscription session

## Rationale

- Python users typically install the Cursor CLI (`agent`) for subscription-based access.
- Porting the full protobuf proxy would duplicate maintenance without improving the primary Python install story.
- The CLI bridge matches how most Python automation environments invoke Cursor today.

## Parity notes

| Feature | TypeScript proxy | Python CLI bridge |
|---------|------------------|-------------------|
| Subscription auth | OAuth (in progress) | `agent login` |
| API key / local proxy | `startProxy()` | Not supported |
| Model list | `GetUsableModels` RPC | `discover_cursor_models()` |
| Streaming | OpenAI-compatible HTTP | `stream_cursor_cli()` |

If protobuf proxy support is needed in Python, track it as a separate feature behind the same provider id with explicit transport selection.
