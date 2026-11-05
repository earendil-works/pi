# Vendored ASFDK harness client

These files are a **verbatim subset** of `NeuroLift-Technologies/asfdk-harness` `src/`, copied so the MVP can build and run without publishing a package.

| Here | Upstream |
|---|---|
| `harness.ts` | `src/harness.ts` |
| `protocols.ts` | `src/protocols.ts` |
| `a2a.ts` | `src/a2a.ts` |
| `tools.ts` | `src/tools.ts` |
| `policy.ts` | `src/policy.ts` |
| `asfdk-runtime.ts` | `src/asfdk-runtime.ts` |
| `extension.ts` | `src/index.ts`, with the MCP server re-exports removed |

Upstream commit: `5488262c96d97026b27703d6580da65c2bcb1fb6` (asfdk-harness#36 merged; `src/` is unchanged by the later docs-only commit `5384a12`). Previously vendored from `f28136d`.

## Rules

- **Do not edit these files here.** Change upstream and re-sync. Upstream treats `policy.ts` as a hard guardrail that needs the owner's approval to change.
- Local difference from upstream: relative imports use a `.ts` extension, as required by `npm run check:ts-imports` (all files). The earlier `readOptionalFile` difference was upstreamed in asfdk-harness#36 and is gone.
- Intentionally **not** vendored: the MCP server, discovery hub, A2A proxy, Cloudflare Worker pipeline (`governance/`, `authority/`, `server.ts`), runtime plugins, and installer.

## What this layer is and is not

This is the ASFDK **harness** layer: it wraps the ASFDK foundation (`@neurolift-technologies/asfdk`) and provides a regex tool-call guardrail (`policy.ts`) for a Pi session. It is a guardrail, not a security boundary. It matches a small list of destructive shell patterns and sensitive paths for the `bash`, `read`, `write`, and `edit` tools only. Upstream also ships with its per-turn preflight hook disabled. Do not describe it as complete enforcement.

It is separate from the development-governance layer (this repository's agent contract) and from ASFDK MCP integration governance.

## Re-syncing

Copy the files above from the new upstream commit, re-apply the `.ts` import-specifier change, update the commit hash in each header and here, and run `npm run check:mvp` and the MVP tests.
