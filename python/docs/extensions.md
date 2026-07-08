# Python extensions

Python extensions live in `~/.pi/agent/extensions/` (or project-local extension dirs). Each extension is a `.py` file exporting `default(pi)` or `activate(pi)`.

## Quick start

```python
# ~/.pi/agent/extensions/hello.py
async def default(pi):
    pi.on("session_start", lambda event, ctx: ctx.ui.notify("Hello from extension", "info"))
```

Reload with `/reload` or restart pi.

## Extension API

The `pi` object mirrors the TypeScript `ExtensionAPI`:

| Method | Description |
|--------|-------------|
| `pi.on(event, handler)` | Register an event handler |
| `pi.register_command(name, options)` | Register a slash command |
| `pi.register_tool(tool)` | Register a custom tool |
| `pi.register_shortcut(key, options)` | Register a keyboard shortcut (interactive mode) |
| `pi.register_message_renderer(type, fn)` | Custom renderer for `role: custom` messages |
| `pi.register_flag(name, options)` | Boolean/string extension flag |
| `pi.send_message(message, options)` | Inject a custom message |
| `pi.send_user_message(content, options)` | Send a user message (starts a turn) |
| `pi.append_entry(custom_type, data)` | Append a session tree entry |
| `pi.set_label(entry_id, label)` | Label a session entry |
| `pi.set_session_name(name)` | Rename the session |
| `pi.get_active_tools()` / `pi.set_active_tools(names)` | Tool visibility |
| `pi.set_model(model)` | Switch model (if configured) |
| `pi.get_thinking_level()` / `pi.set_thinking_level(level)` | Thinking level |

## Events

Supported events (same names as TypeScript):

- Lifecycle: `session_start`, `session_shutdown`, `session_before_new`, `session_before_fork`, `session_before_switch`, `session_before_navigate`, `session_compact`, `session_tree`
- Agent: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `before_agent_start`, `context`
- Messages: `message_start`, `message_update`, `message_end`
- Tools: `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- Input: `input`, `user_bash`
- Provider: `before_provider_request`, `after_provider_response`
- Resources: `resources_discover`

### `before_agent_start`

Return injected custom messages and/or replace the system prompt:

```python
async def default(pi):
    async def on_before(event, ctx):
        return {
            "messages": [
                {
                    "customType": "hint",
                    "content": "Remember to run tests.",
                    "display": True,
                }
            ],
            "systemPrompt": event["systemPrompt"] + "\nBe concise.",
        }

    pi.on("before_agent_start", on_before)
```

### `input`

Intercept user input before templates/commands:

```python
pi.on("input", lambda event, ctx: {"action": "transform", "text": event["text"].upper()})
```

Return `{"action": "handled"}` to swallow input.

### `user_bash`

Intercept `!command` in interactive mode:

```python
pi.on("user_bash", lambda event, ctx: {
    "result": {"output": "intercepted", "exitCode": 0, "cancelled": False, "truncated": False}
})
```

## UI (interactive and RPC modes)

In interactive mode, `ctx.ui` supports:

- `await ctx.ui.select(title, options)`
- `await ctx.ui.confirm(title, message)`
- `await ctx.ui.input(title, placeholder)`
- `ctx.ui.notify(message, type)`

RPC mode forwards these to the client as JSON events.

## Custom messages

```python
pi.send_message(
    {
        "customType": "status",
        "content": "Build passed",
        "display": True,
        "details": {"job": "ci"},
    },
    {"triggerTurn": False},
)
```

Register a renderer for richer TUI output:

```python
def render_status(message, options, theme):
    return f"Status: {message['content']}"

pi.register_message_renderer("status", render_status)
```

## TypeScript extensions

TypeScript extensions under `~/.pi/agent/extensions/*.ts` are loaded via the Node bridge (`ts_extension_host.mjs`). The bridge currently exposes tools and commands only; event handlers, shortcuts, and message renderers require Python extensions.

## Paths

- Built-in discovery: `~/.pi/agent/extensions/`, `.pi/extensions/` in project cwd
- Override with `--extension` / settings `extensions` list
