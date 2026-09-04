# pi-coding-agent

Native Rust Pi CLI and embeddable coding-agent runtime.

```bash
cargo install --path . --locked
pi
pi -p "Review this repository"
pi --mode json "Run the tests"
pi --mode rpc --no-session
```

Configuration remains under `~/.pi/agent`; project resources remain under `.pi`. The crate supports model/auth selection, custom models, trusted project resources, prompts, Agent Skills, themes, executable JSON extensions, JSONL session trees, compaction, retries, HTML export, package management, print/JSON/RPC modes, and the terminal interface.
