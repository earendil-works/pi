# packages/coding-agent/src/modes/rpc

## Purpose
JSON-RPC mode for programmatic control of the pi coding agent. Reads JSON-RPC requests from stdin, sends responses to stdout, enabling integration with IDEs, editors, and other tools.

## Technology
TypeScript, JSON-RPC 2.0 protocol over stdin/stdout with JSONL framing.

## Contents
- `rpc-mode.ts` - `runRpcMode(session)`: starts RPC server listening on stdin, dispatches commands to `AgentSession`
- `rpc-types.ts` - `RpcCommand` discriminated union of all RPC request types, `RpcResponse` discriminated union of all response types, `RpcSessionState`
- `rpc-client.ts` - `RpcClient`: client-side RPC wrapper that spawns a `pi` subprocess and communicates via JSON-RPC. Methods for prompt, model switching, session management, etc.
- `jsonl.ts` - `serializeJsonLine(value)`: serialize value to JSONL line; `attachJsonlLineReader(stream, onLine)`: parse incoming JSONL stream

## Key Functions
- `runRpcMode(session)`: Start RPC server listening on stdin
- `RpcClient.prompt(text, images?)`: Send prompt via RPC
- `RpcClient.setModel(provider, model)`: Switch model via RPC
- `RpcClient.stop()`: Stop agent execution
- `serializeJsonLine(value)`: Serialize to JSONL format
- `attachJsonlLineReader(stream, onLine)`: Attach JSONL line parser to readable stream

## Data Types
- `RpcCommand`: discriminated union of command types (prompt, setModel, setThinking, stop, getState, switchSession, etc.)
- `RpcResponse`: discriminated union of response types (state, event, commandResult, error, sessionList, etc.)
- `RpcSessionState`: `{ model, thinkingLevel, sessionId, sessionName, cwd, ... }`
- `RpcClientOptions`: `{ binPath, cwd, args?, env? }`

## Logging
Errors returned as JSON-RPC error responses.

## CRUD Entry Points
- **Create**: Start via `pi --mode rpc`
- **Read**: Send JSON-RPC requests to stdin, receive responses on stdout
- **Update**: Session state modified via RPC commands
- **Delete**: Session cleanup on disconnect

## Style Guide
- JSON-RPC 2.0 compliant with JSONL framing
- Discriminated union types for all commands and responses
- One method handler per agent operation
- Error codes follow JSON-RPC specification
