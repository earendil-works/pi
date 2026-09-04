# Contributing

Pi is developed as a Rust workspace.

## Setup

Install stable Rust 1.92 or newer, then run:

```bash
cargo build --workspace
cargo test --workspace --all-features
```

## Pull requests

- Keep each change focused.
- Add regression tests for behavior changes.
- Update crate documentation when public behavior changes.
- Do not introduce JavaScript runtime dependencies.
- Run formatting, Clippy with warnings denied, and the full workspace tests before submitting.

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

Use Conventional Commit subjects. Security reports should follow `SECURITY.md` rather than public issue discussion.
