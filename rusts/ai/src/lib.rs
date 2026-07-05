//! # pi-ai
//!
//! Unified LLM API with automatic model discovery and provider configuration.
//!
//! This crate provides a single, consistent interface for interacting with
//! multiple LLM providers (OpenAI, Anthropic, Google, etc.) through a variety
//! of API protocols (chat completions, responses, etc.).
//!
//! ## Architecture
//!
//! The crate is organized in three layers:
//!
//! 1. **Core types** ([`types`]) — Unified message protocol, model descriptors,
//!    event stream types, and options.
//! 2. **API layer** ([`api`]) — Protocol implementations that translate between
//!    the unified types and provider-specific wire formats.
//! 3. **Provider layer** ([`providers`]) — Provider factories that bundle auth,
//!    model catalogs, and API bindings.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use pi_ai::prelude::*;
//! use pi_ai::providers::openai::OpenAIProvider;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Create a models registry and register providers
//!     let mut models = Models::new();
//!     models.set_provider(OpenAIProvider::new());
//!
//!     // Look up a model
//!     let model = models.get_model("openai", "gpt-4o-mini")
//!         .expect("model not found");
//!
//!     // Build a context
//!     let context = Context::new()
//!         .with_system_prompt("You are a helpful assistant.")
//!         .with_messages(vec![
//!             Message::User(UserMessage::text("Hello!"))
//!         ]);
//!
//!     // Stream a completion
//!     use futures::StreamExt;
//!     let mut stream = models.stream(&model.clone(), &context, None);
//!     while let Some(event) = stream.next().await {
//!         match event {
//!             AssistantMessageEvent::TextDelta { delta, .. } => {
//!                 print!("{}", delta);
//!             }
//!             AssistantMessageEvent::Done { message, .. } => {
//!                 println!("\n\nCost: ${:.6}", message.usage.cost.total);
//!             }
//!             _ => {}
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```

pub mod api;
pub mod auth;
pub mod error;
pub mod event_stream;
pub mod images;
pub mod models;
pub mod providers;
pub mod types;
pub mod utils;

/// Convenience re-exports for the most commonly used items.
pub mod prelude {
    pub use crate::error::AiError;
    pub use crate::event_stream::AssistantMessageEventStream;
    pub use crate::api::openai_completions::ThinkingFormat;
    pub use crate::models::{create_provider, AuthMethod, Models, Provider, ProviderConfig};
    pub use crate::providers::deepseek::DeepSeekProvider;
    pub use crate::providers::openai::OpenAIProvider;
    pub use crate::types::*;
}

// Re-export key types at crate root for ergonomic access
pub use error::AiError;
pub use event_stream::AssistantMessageEventStream;
pub use api::openai_completions::ThinkingFormat;
pub use models::{create_provider, AuthMethod, Models, Provider, ProviderConfig};
pub use providers::anthropic::AnthropicProvider;
pub use providers::ant_ling::AntLingProvider;
pub use providers::cerebras::CerebrasProvider;
pub use providers::deepseek::DeepSeekProvider;
pub use providers::fireworks::FireworksProvider;
pub use providers::groq::GroqProvider;
pub use providers::huggingface::HuggingFaceProvider;
pub use providers::kimi_coding::KimiCodingProvider;
pub use providers::minimax::MinimaxProvider;
pub use providers::minimax_cn::MinimaxCnProvider;
pub use providers::moonshotai::MoonshotAIProvider;
pub use providers::nvidia::NvidiaProvider;
pub use providers::openai::OpenAIProvider;
pub use providers::openrouter::OpenRouterProvider;
pub use providers::together::TogetherProvider;
pub use providers::vercel_ai_gateway::VercelAiGatewayProvider;
pub use providers::xai::XaiProvider;
pub use types::{
    AssistantMessage, AssistantMessageEvent, Context, Message, Model, StopReason, Tool, Usage,
    UserMessage,
};

/// Return the crate version.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
