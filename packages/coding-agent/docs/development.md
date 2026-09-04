# Development

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo build --release -p pi-coding-agent
```

First-party runtime code must remain Rust and unsafe Rust is forbidden by workspace lint policy.
