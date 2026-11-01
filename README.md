# NLT-Pi

**NLT-Pi is NeuroLift Technologies' agent runtime and SDK foundation for the NLT Coding Agent (NCA).** It is an NLT-owned project with its own architecture, governance, and development lifecycle. It is not an upstream Pi project or a contribution branch.

NLT-Pi provides the modular TypeScript runtime foundation for a governed coding agent. Its inherited code lineage and third-party notices are documented for licensing provenance; they do not define the project's ownership, governance, roadmap, or contribution workflow.

## What NLT-Pi is

NLT-Pi is the integration point between:

- **Models:** generate responses, intent, and proposed tool calls.
- **ASFDK:** supplies the governance foundation and policy framework.
- **The agent runtime:** orchestrates turns, tools, sessions, and extensions.
- **AgentOS:** provides the agent's execution environment or "computer".
- **External integrations:** connect through governed interfaces such as MCP.

The NLT Coding Agent is the product experience built on this runtime. NLT-Pi owns the runtime and SDK integration layer that makes that experience possible.

## Governance architecture

NLT-Pi is designed around an **ASFDK multi-level governance firewall**. Each level protects a different trust boundary. Passing one level does not grant unrestricted permission to pass the next.

```text
Model output / proposed intent
             |
             v
+----------------------------------+
| 1. ASFDK Foundation              |
| SDK-level governance             |
|                                  |
| Provenance, trust, TOI context,  |
| Sleepwalker, RRT, risk signals   |
+----------------------------------+
             |
             v
+----------------------------------+
| 2. ASFDK Harness                 |
| Agent-level governance           |
|                                  |
| Wraps the agent; resolves policy,|
| authorizes capabilities,         |
| intercepts tool calls, and       |
| enforces approval/escalation     |
+----------------------------------+
             |
             v
+----------------------------------+
| 3. ASFDK MCP                     |
| Integration-level governance     |
|                                  |
| Governs MCP-mediated interactions|
| and exposes governance services  |
+----------------------------------+
             |
             v
+----------------------------------+
| AgentOS                          |
| Execution environment            |
+----------------------------------+
```

### Enforcement principles

- **Every execution path is governed.** Tool calls and other capability invocations must be checked before execution.
- **Authorization is not inherited.** A pass at one governance boundary is not permission to execute or bypass a later boundary.
- **Default deny.** Unknown, malformed, expired, or unresolved authorization decisions do not execute.
- **Approval is action-bound.** Any required human approval must be bound to the requested operation, arguments, principal, and applicable policy context.
- **Fail safely.** If governance cannot establish authorization, execution is blocked or escalated.
- **Execution is independently protected.** AgentOS should verify authorization at its execution boundary rather than relying only on the agent's assertion that an action was approved.
- **Human authority is preserved.** The agent's capabilities do not confer authority to decide beyond its granted permissions.

MCP is an integration boundary, not a mandatory sequential hop for every action. Direct SDK tools and AgentOS operations must have their own enforcement paths so MCP cannot become a bypass.

### Implementation status

The architecture describes the intended NLT Coding Agent operating model. Existing advisory or warning behavior is not considered equivalent to enforcement. The integration is complete only when governance decisions are connected to the actual execution boundaries, bypass paths are closed, and enforcement behavior is covered by tests.

## Architectural responsibilities

| Component | Responsibility |
|---|---|
| `asfdk` | Governance primitives and foundation: TOI/OTOI concepts, provenance, trust, assessment, Sleepwalker, and RRT |
| `asfdk-harness` | Agent-level governance: policy resolution, authorization decisions, interception, approval, escalation, and runtime enforcement |
| `asfdk-dev` | Development-time contract and instructions for agents working within the NLT development environment |
| NLT-Pi / Pi SDK | Integrates governance into the agent lifecycle and enforces decisions before runtime execution |
| MCP | Governance interoperability and governed access to external services |
| AgentOS | Agent execution environment; an independent enforcement point for operations it executes |

These components have distinct responsibilities. The Foundation does not replace the Harness, MCP does not replace runtime enforcement, and the agent must not be able to authorize its own actions.

## Pi foundation

NLT-Pi is based on the TypeScript Pi monorepo and retains its modular packages:

| Package | Description |
|---------|-------------|
| `@earendil-works/chord` | Typed host runtime for plugins, contracts, replicated state, and RPC |
| `@earendil-works/pi-schema` | JSON Schema validation for supported schema drafts |
| `@earendil-works/pi-telemetry` | Vendor-neutral telemetry contracts and adapters |
| `@earendil-works/pi-ai` | Unified multi-provider LLM API |
| `@earendil-works/pi-durable` | Durable conversation, task, and document runtime |
| `@earendil-works/pi-agent-core` | Agent runtime, tool calling, and state management |
| `@earendil-works/pi-codemode` | Sandboxed JavaScript execution through injected tools |
| `@earendil-works/pi-mcp` | Standalone Model Context Protocol client |
| `@earendil-works/pi-env` | Remote execution environments for Pi Durable |
| `@earendil-works/pi-coding-agent` | Interactive coding-agent CLI |
| `@earendil-works/pi-tui` | Terminal UI library |

Some package names and code retain historical upstream provenance. That provenance is preserved in the applicable license and NOTICE files; it does not create an upstream contribution obligation or require compatibility with upstream.

## Getting started

NLT-Pi requires Node.js 22.19 or newer.

Install dependencies from the repository root:

```bash
npm install --ignore-scripts
```

Build the packages:

```bash
npm run build
```

Run the repository checks:

```bash
npm run check
```

Run the coding agent from the source checkout:

```bash
./pi-test.sh
```

For package-specific usage, SDK integration, extensions, skills, prompt templates, themes, RPC, and containerization, consult the documentation under `packages/coding-agent/docs/`.

## Development

Common repository commands:

```bash
npm install --ignore-scripts
npm run build
npm run build:offline
npm run check
./test.sh
./pi-test.sh
```

- `npm run build` refreshes model data and builds the workspace.
- `npm run build:offline` builds using the model data already present.
- `npm run check` runs formatting, dependency, TypeScript, and browser-smoke checks.
- `./test.sh` runs the repository's supported test workflow.
- `./pi-test.sh` is a legacy script name retained in the current checkout; it does not define the project's identity or upstream relationship.

See [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [NLT-DEV-OTOI.md](NLT-DEV-OTOI.md) for NLT-Pi development and governance rules.

## Project direction

NLT-Pi exists to support a coding agent where:

- governance is an execution requirement, not an advisory feature;
- the human remains the final authority;
- model-generated intent is treated as a proposal, not permission;
- the agent's capabilities are constrained by explicit authorization;
- execution and governance decisions are inspectable and attributable;
- the same governance contract can be applied across supported runtimes and integrations.

**Capability does not equal authority. Escalate, do not guess.**

## Licensing and provenance

NLT-Pi uses a **provenance-based, component-level licensing model**. The license for each portion of the repository follows the origin and ownership of that code; the presence of both licenses in this repository does not mean every file is offered under a choice of either license.

- **Inherited MIT-licensed material:** Portions received under the MIT License remain subject to that license and its original notices. The MIT license and Mario Zechner's copyright attribution are preserved in [LICENSE](LICENSE).
- **NeuroLift-authored modifications:** Original modifications and additions authored by NeuroLift Technologies for NLT-Pi / the NLT Coding Agent are licensed under the Apache License, Version 2.0, where identified as NeuroLift contributions. See [LICENSE-APACHE](LICENSE-APACHE).
- **Files containing both upstream and NeuroLift material:** The upstream license and notices continue to apply to the inherited portions. Apache-2.0 applies to the separately copyrightable NeuroLift-authored modifications, not retroactively to upstream material. Modified files should retain upstream notices and clearly identify NeuroLift's changes.
- **Related governance projects:** The asfdk and asfdk-harness projects are licensed under Apache-2.0. Their licenses apply to those projects and do not change the license of upstream Pi code incorporated into or used by NLT-Pi.

This model preserves required third-party attribution while making the licensing of NeuroLift's original work explicit. NLT-Pi is developed independently under NeuroLift's direction; no changes are required to be submitted upstream. When redistributing the combined codebase, comply with the applicable licenses and retain all required notices. The [NOTICE](NOTICE) file records project attribution; it does not replace or alter either license.
