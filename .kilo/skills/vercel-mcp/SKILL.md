---
name: vercel-mcp
description: Approved Vercel MCP server configuration for Pi. Uses the vercel-mcp package (npx vercel-mcp) with VERCEL_API_KEY env var. Configured in .pi/mcp.json and kilo.jsonc. Connecting an external service is an integration decision requiring owner approval; no secrets are committed.
---

# Vercel MCP Server

Approved Vercel MCP server configuration for Pi (the NLT Coding Agent). The server is configured in `.pi/mcp.json` and `.kilo/kilo.jsonc`; no secrets are committed to this repository.

## Package

- **Package:** `vercel-mcp` (v0.0.7, MIT)
- **Binary:** `vercel-mcp`
- **Source:** https://github.com/zueai/vercel-api-mcp
- **Registry:** https://npm.im/vercel-mcp

## Project configuration (`.pi/mcp.json`)

```json
{
  "mcpServers": {
    "vercel": {
      "command": "npx",
      "args": ["vercel-mcp"],
      "env": {
        "VERCEL_API_KEY": "${VERCEL_API_KEY}"
      },
      "description": "Connects to the Vercel API for deployments, DNS, domains, and project management."
    }
  }
}
```

## Kilo configuration (`.kilo/kilo.jsonc`)

The same server is added under the `"mcp"` field in `kilo.jsonc`, using `${VERCEL_API_KEY}` environment-variable reference.

## Governance boundary

Connecting an external tool or service is an external-integration decision and requires the owner's approval. The `VERCEL_API_KEY` credential belongs in the owner's environment, not committed to this repository.

## Tools

Provides Vercel API tools for deployments (list, get, cancel, delete), DNS records, domains, and projects.

## What this skill does not contain

No actual API key or bearer token. Those are owner-decided and must not be committed to this repository.
