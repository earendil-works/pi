# NLT Coding Agent MVP

This directory is the application boundary for the NLT Coding Agent MVP and the configured Vercel project root.

## Vercel application shell

The initial Vercel surface is a read-only status application:

- `public/index.html` provides the accessible, responsive status UI.
- `api/health.js` reports application-function health.
- `api/status.js` reports runtime, governance, and execution integration state.
- `src/status.js` defines the status payload contract.
- `test/` protects the API methods and fail-closed status contract.

The status API is observability only. It is not an ASFDK authorization decision and must never be used to authorize a tool, model, or execution request. Agent execution is explicitly disabled in this shell.

## Runtime foundation

The MVP consumes the checked-in `@earendil-works/pi-coding-agent` workspace at `packages/coding-agent`. The root npm workspace and lockfile make this source authoritative; the MVP does not independently install a potentially different registry release.

Run installation from the repository root. The MVP typecheck is included in the root `npm run check` command as `check:mvp`. Its focused tests run through the workspace test command:

```bash
npm run test --workspace=@neurolift/nlt-pi-mvp
npm run typecheck --workspace=@neurolift/nlt-pi-mvp
```

For the Vercel project using `mvp/` as its Root Directory, **Include source files outside the Root Directory** must remain enabled so the root workspace and `packages/coding-agent` remain available during installation and build.

## Ownership boundaries

- **MVP application:** user-facing application surface and request lifecycle.
- **`packages/coding-agent`:** agent runtime, SDK, sessions, and coding-agent capabilities.
- **ASFDK:** governance and authorization remain separate from model intent and tool availability.
- **AgentOS:** execution environment (the agent's "computer"), not an authority source.
- **Human:** final authority for consequential actions.

## Integration sequence

1. Establish the application surface and health/status observability.
2. Compose the checked-in Pi runtime behind a server-only adapter.
3. Integrate the ASFDK foundation, harness, and MCP layers at their respective boundaries.
4. Bind every model/tool invocation to an explicit governance decision.
5. Verify the independent AgentOS execution boundary and approval/escalation behavior.
6. Add authenticated sessions and persistence only after their providers and data contracts are explicitly selected.

Do not expose coding-agent tools to requests until the ASFDK harness and execution boundary are integrated and verified. Do not interpret the status endpoint as proof of authorization. Do not treat this scaffold as a production-ready agent.

## Current deployment posture

The Vercel project is configured with `mvp/` as its root and the repository root included as a source directory. This change does not trigger a deployment, configure production environment variables, select an authentication provider, or provision persistence.
