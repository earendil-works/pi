# Changelog

## [Unreleased]

### Fixed

- OAuth metadata parsing and `startAuthorization()` now accept only `http:` and `https:` URLs. Before, a server could supply a `file:` or custom protocol authorization endpoint (for example `search-ms:`), which the platform URL handler would launch on sign-in.
- Fixed the excerpt of an HTTP error body in Streamable HTTP errors keeping the whole response body alive ([#9265](https://github.com/earendil-works/pi/issues/9265))

## [1.4.0] - 2026-10-21

## [1.3.0] - 2026-10-15

## [1.2.0] - 2026-10-12

### Breaking Changes

- Changed `CallToolResult.structuredContent` from `Record<string, unknown>` to `unknown`: `callTool()` now accepts any JSON value as structured content, including arrays and `null`, as MCP 2026-07-28 allows, instead of failing with "Invalid MCP tools/call structured content" ([#10416](https://github.com/earendil-works/pi/issues/10416))

### Fixed

- Fixed `authorizeMcp()` exchanging an authorization code whose `iss` parameter could not be checked because no authorization server metadata was discovered. It now throws `OAuthIssuerMismatchError`, whose `expected` is `undefined` in that case (RFC 9207). Reported by [@AizenvoltPrime](https://github.com/AizenvoltPrime)
- Fixed `StreamableHttpTransport` retrying a request after an authorization refresh even though the caller had already cancelled it or it had timed out, so the server still executed it. `McpTransport.send()` now takes an optional `signal`, which `McpClient` aborts once a request settles ([#10598](https://github.com/earendil-works/pi/issues/10598))

## [1.1.0] - 2026-10-07

### Added

- Added a `signal` option to `authorizeMcp()`, `registerClient()`, the token request functions, and the discovery functions, which aborts their requests. An aborted refresh no longer falls back to a new authorization ([#10565](https://github.com/earendil-works/pi/issues/10565))

### Fixed

- Fixed `StreamableHttpTransport.close()` calling `AuthProvider.token()`, which could refresh tokens over the network before the session DELETE and delay closing; the DELETE now reuses the token of the last request ([#10565](https://github.com/earendil-works/pi/issues/10565))

## [1.0.4] - 2026-10-05

### Fixed

- Fixed dynamic client registration failing on OpenID Connect authorization servers with `invalid_redirect_uri` for loopback redirect URIs. `registerClient()` now sends `application_type` (MCP SEP-837), derived from `redirect_uris` when `OAuthClientMetadata.application_type` is not set: `native` for loopback hosts and custom schemes, otherwise `web` ([#10493](https://github.com/earendil-works/pi/issues/10493))

## [1.0.3] - 2026-10-05

## [1.0.2] - 2026-10-04

## [1.0.1] - 2026-10-03

### Breaking Changes

- `OAuthClientProvider.clientMetadataUrl` is replaced by `clientMetadataDocument(metadata)`, which returns the document URL and its redirect URI per authorization server, or `undefined` to register dynamically. It is called whenever no client information is stored, also when the server does not advertise support, and the document is no longer stored as client information ([#10302](https://github.com/earendil-works/pi/issues/10302))

### Added

- `McpOAuthProviderOptions.clientMetadataDocument`, `OAuthCallbackServerOptions.extraPaths`, and a `path` argument for `OAuthCallbackServer.waitForCallback` that rejects responses on other paths ([#10302](https://github.com/earendil-works/pi/issues/10302))

## [1.0.0] - 2026-10-01

### Added

- Added an `authorizationServerMetadataUrl` option to `authorizeMcp()` to use a configured authorization server metadata document instead of discovery ([#10172](https://github.com/earendil-works/pi/issues/10172)).
- Added an `iss` option to `authorizeMcp()`. The authorization code is only exchanged when `iss` names the flow's authorization server, or is absent and the server's metadata does not set `authorization_response_iss_parameter_supported` (RFC 9207).
- Added `stepUpScope()`, which combines the scopes of an `insufficient_scope` challenge with the scopes granted so far.

### Fixed

- Fixed OAuth token and client registration responses with an empty or `null` optional field (such as `"scope": ""`) failing with `Invalid scope` and similar errors; such fields are now treated as absent ([#10266](https://github.com/earendil-works/pi/issues/10266)).
- Fixed `expires_in: null` in a token response marking the access token as already expired.
- Fixed invalid URLs in protected resource metadata aborting OAuth discovery instead of falling back to the MCP server's origin.
- Fixed an empty requested scope, from `scope=""` in a `WWW-Authenticate` challenge or an empty `scopes_supported`, overriding the next scope source.
- Fixed list pagination failing with a duplicate cursor error when a server ends pagination with `nextCursor: ""` or `null`.
- Fixed step-up authorization in `adaptOAuthProvider()` requesting only the scopes of the `insufficient_scope` challenge. The new token lost the scopes granted before, so other requests failed with `insufficient_scope` again. Tokens now record their granted scope, which is the requested scope when the token response omits `scope`.

## [0.99.2] - 2026-09-30

### Fixed

- Fixed `StreamableHttpTransport` failing every request on Cloudflare Workers with `Illegal invocation` by calling `fetch`, including `UnauthorizedContext.fetch`, without a receiver ([#10188](https://github.com/earendil-works/pi/issues/10188))

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Added a standalone MCP client with JSON-RPC lifecycle, tool discovery and calls, cancellation, progress, roots, stdio and Streamable HTTP transports, and an in-memory testing transport.
