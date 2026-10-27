---
owner:
---
# sdk

Embedding pi and non-interactive modes.

In:
- createAgentSession, AgentSession public API, ModelRuntime.
- RPC mode and RpcClient.
- Print and JSON mode (-p), stdin handling.
- pi-ai and agent-core used as libraries: exports, subpaths, bundling, global side effects on the host process.

Examples: #9787, #10470, #9718, #10415, #9537, #10315.

Usually not worth opening: host-specific embedding needs without a general use case.
