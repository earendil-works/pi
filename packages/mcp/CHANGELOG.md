# Changelog

## [Unreleased]

### Fixed

- Fixed `StreamableHttpTransport` failing every request on Cloudflare Workers with `Illegal invocation` by calling `fetch`, including `UnauthorizedContext.fetch`, without a receiver ([#10188](https://github.com/earendil-works/pi/issues/10188))

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Added a standalone MCP client with JSON-RPC lifecycle, tool discovery and calls, cancellation, progress, roots, stdio and Streamable HTTP transports, and an in-memory testing transport.
