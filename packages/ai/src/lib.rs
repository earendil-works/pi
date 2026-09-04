#![allow(missing_docs)]
//! Unified model, provider, streaming, authentication, and tool-call API for Pi.

mod auth;
mod bedrock;
mod catalog;
mod faux;
mod http;
mod images;
mod models;
mod oauth;
mod provider;
mod types;

use std::sync::Arc;

pub use auth::*;
pub use bedrock::*;
pub use catalog::*;
pub use faux::*;
pub use images::*;
pub use models::*;
pub use oauth::*;
pub use provider::*;
use serde_json::Value;
use thiserror::Error;
pub use types::*;

#[derive(Debug, Error)]
pub enum AiError {
    #[error("unknown provider: {0}")]
    UnknownProvider(String),
    #[error("unknown model: {0}/{1}")]
    UnknownModel(String, String),
    #[error("no authentication configured for provider: {0}")]
    MissingAuth(String),
    #[error("provider returned HTTP {status}: {message}")]
    Provider { status: u16, message: String },
    #[error("HTTP request failed: {0}")]
    Http(#[source] reqwest::Error),
    #[error("credential operation failed: {0}")]
    Credential(#[from] CredentialError),
    #[error("invalid tool call: {0}")]
    ToolValidation(String),
    #[error("stream protocol error: {0}")]
    Protocol(String),
    #[error("invalid configuration: {0}")]
    Config(String),
}

#[must_use]
pub fn create_models() -> Models {
    Models::new(Arc::new(InMemoryCredentialStore::default()))
}

#[must_use]
pub fn builtin_models() -> Models {
    let models = create_models();
    register_builtin_providers(&models);
    models
}

#[must_use]
pub fn builtin_models_with_credentials(credentials: Arc<dyn CredentialStore>) -> Models {
    let models = Models::new(credentials);
    register_builtin_providers(&models);
    models
}

pub fn validate_tool_call(tools: &[Tool], call: &Content) -> Result<Value, AiError> {
    let Content::ToolCall { name, arguments, .. } = call else {
        return Err(AiError::ToolValidation("content block is not a tool call".into()));
    };
    let tool = tools
        .iter()
        .find(|tool| tool.name == *name)
        .ok_or_else(|| AiError::ToolValidation(format!("unknown tool: {name}")))?;
    let validator = jsonschema::validator_for(&tool.parameters)
        .map_err(|error| AiError::ToolValidation(format!("invalid schema for {name}: {error}")))?;
    if let Err(error) = validator.validate(arguments) {
        return Err(AiError::ToolValidation(format!(
            "invalid arguments for {name}: {error}"
        )));
    }
    Ok(arguments.clone())
}

#[must_use]
pub fn content_text(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[must_use]
pub fn estimate_tokens(messages: &[Message]) -> u64 {
    let characters = serde_json::to_string(messages).map_or(0, |text| text.chars().count());
    u64::try_from(characters.div_ceil(4)).unwrap_or(u64::MAX)
}

#[must_use]
pub fn is_context_overflow(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "context_length_exceeded",
        "context window",
        "too many tokens",
        "maximum context length",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

#[must_use]
pub fn uuidv7() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[must_use]
pub fn user_agent() -> String {
    format!("pi-ai/{}", env!("CARGO_PKG_VERSION"))
}

#[must_use]
pub fn failed_stream(model: &Model, message: impl Into<String>, reason: StopReason) -> EventStream {
    let mut error = AssistantMessage::empty(model);
    error.stop_reason = reason;
    error.error_message = Some(message.into());
    Box::pin(futures::stream::iter([AssistantMessageEvent::Error { reason, error }]))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::StreamExt;
    use serde_json::json;

    use super::*;

    #[test]
    fn builtin_catalog_has_every_documented_provider() {
        let models = builtin_models();
        assert!(models.get_providers().len() >= 35);
        assert!(models.get_model("anthropic", "claude-sonnet-4-6").is_some());
        assert!(models.get_model("openai", "gpt-4o").is_some());
    }

    #[tokio::test]
    async fn faux_provider_streams_text_and_tool_calls() {
        let provider = "test";
        let model = FauxProvider::default_model(provider, "model");
        let faux = Arc::new(FauxProvider::new(provider, vec![model.clone()], None));
        faux.set_responses([faux_assistant_message(
            &model,
            vec![faux_text("hello"), faux_tool_call("echo", json!({"text":"ok"}))],
            StopReason::ToolUse,
        )]);
        let models = create_models();
        models.set_provider(faux);
        let events = models
            .stream(&model, &Context::default(), StreamOptions::default())
            .await
            .unwrap()
            .collect::<Vec<_>>()
            .await;
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AssistantMessageEvent::TextDelta { .. }))
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, AssistantMessageEvent::ToolcallEnd { .. }))
        );
    }

    #[test]
    fn assistant_messages_round_trip_as_role_tagged_json() {
        let model = FauxProvider::default_model("test", "model");
        let message = Message::Assistant {
            message: faux_assistant_message(&model, vec![faux_text("ok")], StopReason::Stop),
        };
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["role"], "assistant");
        assert_eq!(serde_json::from_value::<Message>(json).unwrap(), message);
    }

    #[test]
    fn validates_tool_arguments() {
        let tools = vec![Tool {
            name: "echo".into(),
            description: String::new(),
            parameters: json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}),
            constrained_sampling: None,
        }];
        assert!(validate_tool_call(&tools, &Content::tool_call("1", "echo", json!({"text":"ok"}))).is_ok());
        assert!(validate_tool_call(&tools, &Content::tool_call("1", "echo", json!({}))).is_err());
    }
}
