---
name: rivet-mcp
description: Approved Rivet MCP server configuration for Pi. Uses the @rivetjs/mcp package (npx -y @rivetjs/mcp, stdio). Configured in .pi/mcp.json and kilo.jsonc. No credentials required; connecting an external service is an integration decision requiring owner approval.
---

# Rivet MCP Server

Approved Rivet MCP server configuration for Pi (the NLT Coding Agent). The server is configured in `.pi/mcp.json` and `.kilo/kilo.jsonc`; no secrets are committed to this repository.

## Package

- **Package:** `@rivetjs/mcp` (v0.1.0-alpha.6, MIT)
- **Binary:** `rivet-mcp`
- **Source:** https://github.com/N1XUS/rivetjs/tree/main/libs/mcp
- **Registry:** https://npm.im/@rivetjs/mcp

## Project configuration (`.pi/mcp.json`)

```json
{
  "mcpServers": {
    "rivet": {
      "command": "npx",
      "args": ["-y", "@rivetjs/mcp"],
      "description": "Rivet MCP server for offline docs search, components, and compiler diagnostics."
    }
  }
}
```

## Kilo configuration (`.kilo/kilo.jsonc`)

The same server is added under the `"mcp"` field in `kilo.jsonc`.

## Governance boundary

Connecting an external tool or service is an external-integration decision and requires the owner's approval. This stdio server requires no authentication.

## Tools

Provides Rivet framework tools: `component <Name>`, `search <words>`, `check <file>` (offline docs search, components, compiler diagnostics).

## What this skill does not contain

No credentials or connection secrets. This server requires no authentication.
