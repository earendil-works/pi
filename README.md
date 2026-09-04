# Pi Agent Harness — Rust

Pi is a terminal coding-agent harness implemented as a native Rust workspace. The runtime, model adapters, agent loop, terminal UI, session storage, RPC stack, package manager, and evaluation helpers do not require Node.js, Bun, or a JavaScript runtime.

## Crates

| Crate | Purpose |
|---|---|
| `pi-ai` | Unified streaming LLM APIs, model catalog, auth, OAuth, images, usage, and tool schemas |
| `pi-agent-core` | Agent loop, parallel tools, queues, compaction, JSONL sessions, and coding tools |
| `pi-tui` | Differential main/alternate-screen rendering, components, Unicode input, and images |
| `pi-coding-agent` | `pi` CLI, settings, resources, native extension protocol, print/JSON/RPC/TUI modes |
| `chord` | Contexts, services, facets, replicated JSON state, and deltas |
| `pi-protocol` | Strict routed envelopes, CBOR, and bounded byte framing |
| `pi-client` / `pi-server` | Async protocol peers and Unix-domain socket transport |
| `pi-session-backend-sqlite` | WAL-backed durable session repository |
| `pi-telemetry` | Vendor-neutral explicit telemetry |
| `pi-evals` | Reproducible model-backed evaluation harness |

## Build and install

Rust 1.92 or newer is required.

```bash
cargo build --release --workspace
cargo install --path packages/coding-agent --locked
```

The resulting executable is `pi`.

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi

# One-shot text output
pi -p "Summarize this repository"

# Machine-readable event stream
pi --mode json "List the Rust crates"

# JSONL RPC over stdin/stdout
pi --mode rpc --no-session
```

Built-in coding tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Sessions remain compatible with Pi's version-3 JSONL tree format under `~/.pi/agent/sessions`.

## Configuration and resources

Pi reads global files from `~/.pi/agent` and trusted project files from `.pi`:

- `settings.json`
- `models.json`
- `auth.json`
- `prompts/*.md`
- `skills/**/SKILL.md`
- `themes/*.json`
- `extensions/*.json`

Native extension manifests launch isolated executable extensions using a versioned JSON stdin/stdout contract. An extension can register tools, commands, and event hooks without loading code into the Pi process. This preserves language neutrality while the host remains entirely Rust.

## Development

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

The workspace forbids unsafe Rust in first-party crates.

## License

MIT
