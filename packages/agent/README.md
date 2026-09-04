# pi-agent-core

Native Rust stateful agent runtime built on `pi-ai`.

```rust
let mut options = pi_agent_core::AgentOptions::new(model);
options.tools = pi_agent_core::create_coding_tools(std::env::current_dir()?);
let agent = pi_agent_core::Agent::new(models, options);
agent.prompt("Inspect this project").await?;
```

It includes ordered lifecycle events, streaming assistant state, parallel or sequential tool batches, steering and follow-up queues, cancellation, retries at the session layer, compaction, version-3 JSONL session trees, and built-in read/write/edit/bash/grep/find/ls tools.
