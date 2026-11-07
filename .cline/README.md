# .cline — NLT-Pi Cline Configuration

Project-level Cline configuration for agents working on NLT-Pi. This directory holds Cline-specific settings, agent profiles, and hooks that apply the repository's governance model (development governance, ASFDK foundation/harness/MCP layers) to Cline sessions.

## Contents

| Path | Purpose |
|---|---|
| `settings.json` | Cline settings: governance environment variables, permissions, and the session-start hook. |
| `hooks/session-start.sh` | Displays governance entry points and checks required files on each session start. |
| `agents/nlt-implementation-agent.md` | Cline agent profile implementing the scoped-implementation role. |
| `skills/` | Skill references; loadable skills live in `.agents/skills/`. |

## Relationship to `.agents/` skills

Loadable Agent Skills live in `.agents/skills/` (Pi's documented project skill location). This directory references them rather than duplicating governance guidance, so every agent surface (`.claude/`, `.kilo/`, `.cline/`) uses the same skills.

## MCP server setup for Cline

Cline uses the `claude-code-settings.json` schema, which does not support project-level `mcpServers` in `.cline/settings.json`. MCP server configuration for Cline is user-level only.

To give Cline access to the same Vercel and Rivet MCP servers configured for Pi and Kilo, add them to your user-level config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "vercel": {
      "command": "npx",
      "args": ["vercel-mcp"],
      "env": {
        "VERCEL_API_KEY": "<your-vercel-api-key>"
      },
      "description": "Connects to the Vercel API for deployments, DNS, domains, and project management."
    },
    "rivet": {
      "command": "npx",
      "args": ["-y", "@rivetjs/mcp"],
      "description": "Rivet MCP server for offline docs search, components, and compiler diagnostics."
    }
  }
}
```

The project-level equivalents are committed to `.pi/mcp.json` (Pi) and `.kilo/kilo.jsonc` (Kilo). No secrets are committed to this repository — set `VERCEL_API_KEY` in your own environment.

Project-specific engineering authority and architecture boundaries are defined in root `AGENTS.md` and `NLT-DEV-OTOI.md`. Capability does not equal authority; escalate, do not guess.
