#!/bin/bash
# Build satellite MCP server as a single binary
set -e
cd "$(dirname "$0")"
echo "Building satellite MCP server..."
bun build --compile satellite-mcp.ts --outfile satellite-mcp
echo "Binary: $(pwd)/satellite-mcp"
ls -lh satellite-mcp
