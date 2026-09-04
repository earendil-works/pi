# Development Rules

## Scope

Pi is a native Rust workspace. First-party runtime code must be Rust. Do not add Node.js, Bun, npm lifecycle, TypeScript, JavaScript, or native C/C++ runtime requirements.

## Code

- Use stable Rust 1.92 or newer and edition 2024.
- Keep implementations simple; avoid unsafe Rust.
- Keep files below 1,000 lines or document why one cohesive implementation must remain intact.
- Preserve strict JSON and protocol compatibility where formats are public.
- Never log credentials, request authorization headers, prompts, tool arguments, or file contents as telemetry.
- Add tests for changed behavior.

## Required checks

After code changes run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

For CLI or TUI changes, also build `pi` and perform an isolated smoke test. Interactive tests may use tmux.

## Dependencies

- Pin security-sensitive SDK families when their MSRV can drift; keep `Cargo.lock` committed.
- Do not execute dependency build/install scripts outside Cargo.
- Review network, cryptography, archive, and process-execution dependencies before adding them.

## Git

- Do not commit unless requested.
- Stage explicit paths only.
- Do not destroy unrelated worktree changes.
- Use Conventional Commits and signed commits.
