#!/bin/bash
# Build satellite MCP server as a single binary
set -e
cd "$(dirname "$0")"
echo "Building satellite MCP server..."
bun build --compile satellite-server.ts --outfile satellite-server
echo "Binary: $(pwd)/satellite-mcp"
ls -lh satellite-mcp
