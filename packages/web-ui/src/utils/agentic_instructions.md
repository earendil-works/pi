# packages/web-ui/src/utils

## Purpose
Shared utility modules for the web UI: attachment handling, authentication, formatting, internationalization, and proxy configuration.

## Technology
TypeScript, browser APIs.

## Contents
- `attachment-utils.ts` - `loadAttachment()`: load file attachments from File API, detect types, resize images
- `auth-token.ts` - `getAuthToken()`, `clearAuthToken()`: manage authentication tokens in browser storage
- `format.ts` - `formatCost()`, `formatModelCost()`, `formatTokenCount()`, `formatUsage()`: number formatting for costs and token counts
- `i18n.ts` - `i18n()`, `setLanguage()`, `translations`: internationalization with translation lookup
- `proxy-utils.ts` - `applyProxyIfNeeded()`, `createStreamFn()`, `shouldUseProxyForProvider()`, `isCorsError()`: CORS proxy configuration for browser-based LLM requests
- `model-discovery.ts` - `discoverOllamaModels(baseUrl)`: discovers locally running Ollama models via API, returns `Model[]`
- `test-sessions.ts` - Test session data fixtures for development and testing (e.g., `simpleHtml`)

## Key Functions
- `loadAttachment(file)`: Load File object, return `Attachment` with type detection
- `formatCost(cost)`: Format dollar cost with appropriate precision
- `formatTokenCount(count)`: Format token count with K/M suffixes
- `i18n(key, params?)`: Look up translated string
- `createStreamFn(proxyUrl?)`: Create stream function with optional proxy
- `shouldUseProxyForProvider(provider)`: Check if provider needs CORS proxy
- `discoverOllamaModels(baseUrl)`: Discover Ollama models. Returns `Promise<Model[]>`

## Data Types
- `Attachment`: `{ name, type, data, mimeType, size }`

## Logging
N/A

## CRUD Entry Points
- **Create**: Add new utility files as needed
- **Read**: Import utilities from this directory
- **Update**: Modify utility implementations
- **Delete**: Remove unused utilities

## Style Guide
- One utility per file
- Browser-compatible (no Node.js APIs)
- Pure functions where possible
