# CLI Integration

Pi starts with its interactive terminal interface when stdin and stdout are terminals and no other mode is selected. The CLI also provides print, JSON, and RPC modes for scripts and applications.

All four modes use the same agent, sessions, resources, and tools. The mode determines how input enters Pi, how output is exposed, and whether the process remains available for more commands.

The SDK is not a CLI mode. It embeds the agent directly in a Node.js or Bun process. See the [SDK](sdk.md) when direct TypeScript access is preferable to a process boundary.

## Choose a mode

| Mode | Interface | Lifetime | Use it when |
|---|---|---|---|
| Interactive | Terminal UI | Until the user exits | A person is working with Pi directly |
| Print | Final text on stdout | One invocation | A script needs the final assistant response |
| JSON | JSONL events on stdout | One invocation | A process needs structured progress from a run |
| RPC | JSONL commands, responses, and events | Long-lived | A process needs bidirectional control |

CLI options still select the working directory, model, tools, resources, and session persistence independently of the mode. See [CLI and Modes](cli.md) for the complete startup options.

## Print mode

Print mode runs the supplied prompts, writes the final assistant text to stdout, and exits:

```bash
pi --print "Summarize the changes in this repository"
```

Use print mode when only the final text is needed, including command substitution, pipelines, and one-shot jobs. Intermediate events are not exposed.

Errors are written to stderr. A failed or aborted model response produces a nonzero exit status.

When no mode is selected explicitly, non-TTY stdin or stdout also selects print mode. This allows piped input and output without adding `--print`.

## JSONL event stream

JSON mode writes a session header followed by agent and session events as newline-delimited JSON:

```bash
pi --mode json "Review this repository" > events.jsonl
```

This is structured event output, not a single JSON result or a constraint on the format of the model’s response.

All prompts are supplied when the process starts. The process streams events for that run and then exits; it does not accept later commands.

Streaming `message_update` records contain deltas rather than a growing message snapshot. Assemble live output from the delta events, then replace it with the authoritative message from `message_end`.

`agent_end` can be followed by automatic recovery or queued work. `agent_settled` marks the end of automatic work for the current run.

Stdout is reserved for JSONL. Diagnostics and application logging are written to stderr. See [JSON Event Stream](json.md) for event shapes and reconstruction rules.

## RPC mode

RPC mode keeps Pi running while another process sends commands and receives responses and events:

```bash
pi --mode rpc --no-session
```

Commands are JSON objects written to stdin. Responses and events are JSON objects written to stdout. Every record occupies one line.

Add an `id` to commands that need correlation. The matching response repeats that ID. Events generally have no command ID because they describe session activity rather than one request.

A successful `prompt` response means the prompt was accepted, queued, or handled. It does not mean the run completed. Continue consuming events through `agent_settled` when completion matters.

RPC commands can change models, inspect state, manage sessions, run shell commands, and answer extension UI requests. See [RPC Protocol](rpc.md) for the complete contract.

Extension dialogs form a request-response subprotocol. Other extension UI updates are notifications that a client may display or ignore. TUI-only extension capabilities are unavailable or degraded outside interactive mode.

### Typed Node.js client

`RpcClient` is exported by `@earendil-works/pi-coding-agent`. It starts a Pi RPC child process, correlates requests, exposes typed command methods, and delivers session events to listeners.

The [RPC client example](../examples/rpc-client.ts) sends one prompt, streams text and tool activity, waits for `agent_settled`, and shuts down the child process. It is included in the repository’s TypeScript checks.

`RpcClient.promptAndWait()` installs its event listener before sending the prompt, avoiding a race with fast completions. For separate operations, subscribe before calling `prompt()` and call `waitForIdle()` only while a run is active.

The client requires a path to a runnable Pi CLI. The repository example points at `dist/cli.js`, so the package must be built before that example runs from a checkout.

## Implement a JSONL client

JSON and RPC use strict JSONL framing. Split records only on LF (`\n`) and strip an optional preceding carriage return. Unicode line and paragraph separators are valid inside JSON strings and are not record boundaries.

Node.js `readline` recognizes additional Unicode separators, so it does not implement this framing correctly. Pi’s `RpcClient` uses a strict LF-only reader.

Read stdout continuously. Pi applies backpressure while writing events, but a client that stops reading can still stall the agent. Custom RPC clients must also write complete commands and honor stdin backpressure.

Closing RPC stdin requests an orderly shutdown. Clients must still handle child-process errors, unexpected exits, stderr diagnostics, cancellation, and application-specific deadlines.

## Examples and reference

- [RPC client](../examples/rpc-client.ts): typed Node.js integration
- [RPC extension UI](../examples/rpc-extension-ui.ts): custom terminal client with extension dialogs
- [CLI and Modes](cli.md): startup options and mode selection
- [JSON Event Stream](json.md): JSON event reference
- [RPC Protocol](rpc.md): RPC command and event reference
- [SDK examples](../examples/sdk/): in-process TypeScript integrations
