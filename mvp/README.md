# NLT Coding Agent MVP

This directory is the application boundary for the first NLT Coding Agent MVP and the intended Vercel project root.

## Runtime foundation

The MVP consumes the existing `@earendil-works/pi-coding-agent` package from NLT-Pi. It does not fork, duplicate, or modify the coding-agent runtime.

## Ownership boundaries

- **MVP application:** user-facing application and request lifecycle.
- **`packages/coding-agent`:** agent runtime, SDK, sessions, and coding-agent capabilities.
- **ASFDK:** governance and authorization remain separate from model intent and tool availability.
- **AgentOS:** execution environment ("computer"), not an authority source.
- **Human:** final authority for consequential actions.

## Initial scope

This commit establishes the package boundary only. It does not yet select a Vercel framework, configure deployment, expose tools, add authentication, choose persistence, or connect an external provider. Those decisions remain explicit follow-up work.

Do not expose coding-agent tools to requests until the ASFDK harness and execution boundary are integrated and verified. Do not treat this scaffold as a deployed or production-ready agent.
