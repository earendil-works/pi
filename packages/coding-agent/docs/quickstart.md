# Quick start

```bash
cargo install --path packages/coding-agent --locked
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

Use `pi login <provider>` to store a key in `~/.pi/agent/auth.json`. `pi -p` prints one response, `--mode json` emits events, and `--mode rpc` provides JSONL process integration.
