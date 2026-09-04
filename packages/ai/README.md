# pi-ai

Native Rust multi-provider LLM toolkit for Pi.

```rust
use pi_ai::{builtin_models, Context, StreamOptions};

let models = builtin_models();
let model = models.get_model("anthropic", "claude-sonnet-4-6").unwrap();
let response = models.complete(&model, &Context::default(), StreamOptions::default()).await?;
println!("{}", response.text());
```

The crate provides typed messages and content blocks, SSE streaming events, OpenAI Chat/Responses, Anthropic Messages, Google, Mistral, compatible gateways, OAuth PKCE/device flows, persistent credentials, image generation, constrained tool schemas, cost accounting, cancellation, cross-provider replay, and a deterministic faux provider.
