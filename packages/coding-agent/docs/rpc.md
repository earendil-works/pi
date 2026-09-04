# RPC

Start `pi --mode rpc --no-session`. stdin and stdout use strict LF-delimited JSON objects. Commands may carry an `id`; responses echo it. Agent lifecycle and streaming events are emitted independently.

Core commands: `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `set_thinking_level`, `compact`, `bash`, `new_session`, `switch_session`, `fork`, `clone`, `get_entries`, `get_session_stats`, `export_html`, and `get_commands`.

```json
{"id":"1","type":"prompt","message":"Hello"}
```
