# Pi Monorepo

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-proxy](packages/proxy)** | CORS proxy for browser-based LLM API calls |
| **[@mariozechner/pi](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Development

### Setup

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
```

### Development

Start watch builds for all packages:
```bash
npm run dev
```

Then run with tsx:
```bash
cd packages/coding-agent && npx tsx src/cli.ts
cd packages/pods && npx tsx src/cli.ts
```

### Versioning (Lockstep)

**All packages MUST always have the same version number.** Use these commands to bump versions:

```bash
npm run version:patch    # 0.7.5 -> 0.7.6
npm run version:minor    # 0.7.5 -> 0.8.0
npm run version:major    # 0.7.5 -> 1.0.0
```

These commands:
1. Update all package versions to the same number
2. Update inter-package dependency versions (e.g., `pi-agent` depends on `pi-ai@^0.7.7`)
3. Update `package-lock.json`

**Never manually edit version numbers.** The lockstep system ensures consistency across the monorepo.

### Publishing

Complete release process:

1. **Update CHANGELOG.md** (if changes affect coding-agent):
   ```bash
   # Add your changes to the [Unreleased] section in packages/coding-agent/CHANGELOG.md
   ```

2. **Bump version** (all packages):
   ```bash
   npm run version:patch    # For bug fixes
   npm run version:minor    # For new features
   npm run version:major    # For breaking changes
   ```

3. **Update CHANGELOG.md version** (if changes affect coding-agent):
   ```bash
   # Move the [Unreleased] section to the new version number with today's date
   # e.g., ## [0.7.16] - 2025-11-17
   ```

4. **Commit and tag**:
   ```bash
   git add .
   git commit -m "Release v0.7.16"
   git tag v0.7.16
   git push origin main
   git push origin v0.7.16
   ```

5. **Publish to npm**:
   ```bash
   npm run publish        # Publish all packages to npm
   ```

## License

MIT