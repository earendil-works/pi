# Native extensions

Pi remains entirely Rust and does not evaluate in-process scripts. Extensions are executable JSON protocol adapters declared by `.json` manifests in `~/.pi/agent/extensions`, `.pi/extensions`, or Pi packages.

```json
{"name":"example","commands":{"hello":{"description":"Say hello","command":"bin/example","args":[]}},"tools":[{"name":"lookup","label":"Lookup","description":"Look up a value","parameters":{"type":"object"},"command":"bin/example"}],"hooks":{"tool_call":{"command":"bin/example"}}}
```

Pi sends one JSON value on stdin and expects one JSON value on stdout. Tool results use `AgentToolResult`. Hooks include `context`, `tool_call`, `tool_result`, and `turn_end`. Executables run with package-relative paths and inherit normal OS permissions; only install trusted packages.
