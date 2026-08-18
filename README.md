<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@tculpepp/spi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@tculpepp/spi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi — Secure Closed-Network Fork

This is a security fork of [earendil-works/pi](https://github.com/earendil-works/pi)
maintained for deployment in closed networks and high-security environments. It is
**not** the upstream project. Upstream's own README follows below.

Synced with upstream **v0.84.2**.

## What this fork changes

### 1. Outbound non-LLM calls are permanently disabled

Version checks, package update checks, model-catalog fetches, and session sharing are
suppressed at startup regardless of environment variables or flags. Upstream's code
paths are gated rather than deleted, so diffs against upstream stay readable.

| Feature | Upstream | This fork |
|---------|----------|-----------|
| npm version check at startup | Opt out via `PI_SKIP_VERSION_CHECK` | Always off |
| Package update checks | Opt out via `PI_OFFLINE` | Always off |
| Model catalog refresh over the network | On when not offline | Always off |
| `/share` (GitHub gist upload) | Available | Returns an error |

`SPI_OFFLINE` and `SPI_SKIP_VERSION_CHECK` are forced on at the top of `main()`, so no
flag combination re-enables them. `ModelRuntime.refresh()` treats the offline flag as a
ceiling: a caller passing `allowNetwork: true` still cannot reach the network.

### 2. `secureMode` — provider allowlist enforcement

`secureMode` is **on by default**. A provider is usable only when it has an explicit
`baseUrl`, which is how an operator points it at internal infrastructure. Every built-in
commercial endpoint (Anthropic, OpenAI, Google, Mistral, Bedrock, and the rest) is
blocked unless redirected. The protocol implementations stay intact, so self-hosted
models can reuse them without extra code.

Enforcement lives in `ModelRuntime`, which is where providers, `baseUrl`, and
availability actually live. `ModelRegistry` re-exports the policy for extensions.

- `prepareRequest()` — the choke point every stream, complete, and deferred call passes
  through, so a model that reached it by any resolution path still cannot send a request
- the available-model snapshot — filtered at all four sites that compute it
- `registerProvider()` and `registerNativeProvider()` — an extension cannot register a
  cloud-reaching provider
- `resolveCliModel()` — gated at its single exit rather than at each return path

The policy fails closed: `secureMode` defaults to on in the runtime field, in
`CreateModelRuntimeOptions`, and in `SettingsManager.getSecureMode()`. A creation site
that never wires settings stays secure rather than open.

Disable it, if you must, with `"secureMode": false` in `settings.json`.

### 3. No default models

Under `secureMode` the app starts with an empty model list. Configure at least one
provider in `~/.spi/agent/models.json` before launching.

## Configuring a self-hosted model

`~/.spi/agent/models.json`:

```json
{
  "providers": {
    "internal-llm": {
      "baseUrl": "http://inference.internal:8000/v1",
      "api": "openai-completions",
      "apiKey": "INTERNAL_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gemma-3-27b-it",
          "name": "Gemma 3 27B (Internal)",
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

`~/.spi/agent/settings.json`:

```json
{
  "defaultProvider": "internal-llm",
  "defaultModel": "gemma-3-27b-it"
}
```

See [packages/coding-agent/docs/models.md](packages/coding-agent/docs/models.md) for the
full reference, including how to redirect built-in providers through an internal proxy.

## Naming

The CLI is `spi`, the config directory is `~/.spi`, environment variables use the `SPI_`
prefix, and packages publish under `@tculpepp/spi-*`. For compatibility, the extension
loader still resolves upstream's `@earendil-works/pi-*` and legacy `@mariozechner/pi-*`
specifiers, and package manifests accept upstream's `pi` key as well as `spi`.

## Upstream

Original project: [earendil-works/pi](https://github.com/earendil-works/pi) by
[Mario Zechner](https://github.com/badlogic). All credit for the core agent, TUI, and
provider infrastructure belongs to the upstream project. This fork adds closed-network
and secure-mode defaults on top.

---

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@tculpepp/spi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@tculpepp/spi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@tculpepp/spi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@tculpepp/spi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@tculpepp/spi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@tculpepp/spi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@tculpepp/spi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@tculpepp/spi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `SPI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
