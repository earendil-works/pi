# Environment

Environment variables, external dependencies, and setup notes for the MCP mission.

**What belongs here:** required env vars, external endpoints, auth/setup notes, dependency quirks.
**What does not belong here:** service ports or startup commands (use `.factory/services.yaml`).

---

## External endpoints

- Real Figma MCP endpoint is already referenced outside the repo at:
  - `~/.codex/config.toml`
  - `~/.factory/mcp.json`

## Expected credentials

- Prefer env-backed bearer-token configuration for the initial real Figma validation path.
- Keep the runtime compatible with future OAuth-backed MCP auth flows.
- Never commit bearer tokens, OAuth secrets, or callback credentials into the repository.

## Local constraints

- Do not run `npm run dev`.
- Reserved local MCP harness ports: `3200-3299`.
- Known occupied ports to avoid during this mission: `3000`, `5000`, `5173`, `5432`, `6379`.

## Package focus

- Primary package under active development: `packages/coding-agent`.
- Root validation remains required before completion because repo guidance requires `npm run check`.
