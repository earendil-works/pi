# Worklog: apply_patch golden master (2026-01-23)

- Vendored codex apply-patch crate into tools/codex-apply-patch (with Rust 1.80-compatible tweaks).
- Added characterization harness + generator + vitest + golden output.
- Generated apply-patch.golden.txt via tsx script (cargo build).
- Verified: npx vitest --run packages/coding-agent/src/tools/apply-patch.golden.test.ts
