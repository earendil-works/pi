# @kennyfrc/mu-proxy

CORS and authentication proxy for mu-ai. Enables browser clients to access OAuth-protected endpoints.

## Usage

### CORS Proxy

Zero-config CORS proxy for development:

```bash
# Run directly with tsx
npx tsx packages/proxy/src/cors-proxy.ts 3001

# Or use npm script
npm run dev -w @kennyfrc/mu-proxy

# Or install globally and use CLI
npm install -g @kennyfrc/mu-proxy
mu-proxy 3001
```

The proxy will forward requests to any URL:

```javascript
// Instead of:
fetch('https://api.anthropic.com/v1/messages', { ... })

// Use:
fetch('http://localhost:3001?url=https://api.anthropic.com/v1/messages', { ... })
```

### OAuth Integration

For Anthropic OAuth tokens, configure your client to use the proxy:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: 'oauth_token_here',
  baseURL: 'http://localhost:3001?url=https://api.anthropic.com'
});
```

## Future Proxy Types

- **BunnyCDN Edge Function**: Deploy as edge function
- **Managed Proxy**: Self-hosted with provider key management and credential auth
- **Cloudflare Worker**: Deploy as CF worker

## Architecture

The proxy:
1. Accepts requests with `?url=<target>` query parameter
2. Forwards all headers (except `host`, `origin`)
3. Forwards request body for non-GET/HEAD requests
4. Returns response with CORS headers enabled
5. Strips CORS headers from upstream response

## Development

```bash
npm install
npm run build
npm run check
```
