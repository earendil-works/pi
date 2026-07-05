use std::collections::HashMap;

use async_trait::async_trait;
use futures::StreamExt;

use crate::api::openai_completions;
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

// ─── Model Catalog ─────────────────────────────────────────────────────────────

/// Return the static model catalog for OpenAI Completions models.
pub fn openai_models() -> Vec<Model> {
    vec![
        Model {
            id: "gpt-4o".into(),
            name: "GPT-4o".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, Some("minimal".into()));
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m
            },
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost {
                input: 2.50,
                output: 10.0,
                cache_read: 1.25,
                cache_write: 3.75,
            },
            context_window: 128_000,
            max_tokens: 16_384,
            headers: HashMap::new(),
        },
        Model {
            id: "gpt-4o-mini".into(),
            name: "GPT-4o Mini".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: false,
            thinking_level_map: HashMap::new(),
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost {
                input: 0.15,
                output: 0.60,
                cache_read: 0.075,
                cache_write: 0.15,
            },
            context_window: 128_000,
            max_tokens: 16_384,
            headers: HashMap::new(),
        },
        Model {
            id: "o3".into(),
            name: "o3".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m
            },
            input: vec![InputModality::Text],
            cost: ModelCost {
                input: 10.0,
                output: 40.0,
                cache_read: 2.50,
                cache_write: 10.0,
            },
            context_window: 200_000,
            max_tokens: 100_000,
            headers: HashMap::new(),
        },
        Model {
            id: "o4-mini".into(),
            name: "o4-mini".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m
            },
            input: vec![InputModality::Text],
            cost: ModelCost {
                input: 1.10,
                output: 4.40,
                cache_read: 0.275,
                cache_write: 1.10,
            },
            context_window: 200_000,
            max_tokens: 100_000,
            headers: HashMap::new(),
        },
    ]
}

// ─── OpenAI Provider ───────────────────────────────────────────────────────────

/// The OpenAI provider, implementing the `Provider` trait.
///
/// This provider supports the `openai-completions` API for chat models
/// (GPT-4o, o3, o4-mini, etc.).
pub struct OpenAIProvider {
    auth: AuthMethod,
    models: Vec<Model>,
}

impl OpenAIProvider {
    /// Create a new OpenAI provider with the default static model catalog.
    pub fn new() -> Self {
        OpenAIProvider {
            auth: AuthMethod::ApiKey(ApiKeyAuth {
                name: "OpenAI API key".into(),
                env_vars: vec!["OPENAI_API_KEY".into()],
            }),
            models: openai_models(),
        }
    }
}

impl Default for OpenAIProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for OpenAIProvider {
    fn id(&self) -> &str {
        "openai"
    }

    fn name(&self) -> &str {
        "OpenAI"
    }

    fn base_url(&self) -> Option<&str> {
        Some("https://api.openai.com/v1")
    }

    fn headers(&self) -> Option<&ProviderHeaders> {
        None
    }

    fn auth(&self) -> &AuthMethod {
        &self.auth
    }

    fn get_models(&self) -> &[Model] {
        &self.models
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        let (stream, sender) = create_event_stream();
        let owned_model = model.clone();
        let owned_context = context.clone();
        let owned_options = options.cloned();
        let auth = self.auth.clone();

        tokio::spawn(async move {
            // Resolve auth
            let api_key = match resolve_provider_auth(
                &auth,
                owned_options.as_ref().and_then(|o| o.api_key.as_deref()),
                owned_options.as_ref().and_then(|o| o.env.as_ref()),
            )
            .await
            {
                Ok(Some(resolved)) => resolved.api_key,
                Ok(None) => {
                    let msg = AssistantMessage::error(
                        owned_model.api,
                        owned_model.provider.clone(),
                        &owned_model.id,
                        format!("No API key configured for {}. Set OPENAI_API_KEY.", owned_model.provider.as_str()),
                    );
                    let _ = sender.push(AssistantMessageEvent::Error {
                        reason: StopReason::Error,
                        error: msg,
                    });
                    return;
                }
                Err(e) => {
                    let msg = AssistantMessage::error(
                        owned_model.api,
                        owned_model.provider.clone(),
                        &owned_model.id,
                        e.to_string(),
                    );
                    let _ = sender.push(AssistantMessageEvent::Error {
                        reason: StopReason::Error,
                        error: msg,
                    });
                    return;
                }
            };

            // Delegate to the API implementation
            let api_stream = openai_completions::stream(
                &owned_model,
                &owned_context,
                owned_options.as_ref(),
                api_key.as_deref(),
            );

            let mut api_stream = Box::pin(api_stream);
            while let Some(event) = api_stream.next().await {
                if sender.push(event).is_err() {
                    break;
                }
            }
        });

        stream
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        let (stream, sender) = create_event_stream();
        let owned_model = model.clone();
        let owned_context = context.clone();
        let owned_options = options.cloned();
        let auth = self.auth.clone();

        tokio::spawn(async move {
            let api_key = match resolve_provider_auth(
                &auth,
                owned_options.as_ref().and_then(|o| o.base.api_key.as_deref()),
                owned_options.as_ref().and_then(|o| o.base.env.as_ref()),
            )
            .await
            {
                Ok(Some(resolved)) => resolved.api_key,
                Ok(None) => {
                    let msg = AssistantMessage::error(
                        owned_model.api,
                        owned_model.provider.clone(),
                        &owned_model.id,
                        format!("No API key configured for {}. Set OPENAI_API_KEY.", owned_model.provider.as_str()),
                    );
                    let _ = sender.push(AssistantMessageEvent::Error {
                        reason: StopReason::Error,
                        error: msg,
                    });
                    return;
                }
                Err(e) => {
                    let msg = AssistantMessage::error(
                        owned_model.api,
                        owned_model.provider.clone(),
                        &owned_model.id,
                        e.to_string(),
                    );
                    let _ = sender.push(AssistantMessageEvent::Error {
                        reason: StopReason::Error,
                        error: msg,
                    });
                    return;
                }
            };

            let api_stream = openai_completions::stream_simple(
                &owned_model,
                &owned_context,
                owned_options.as_ref(),
                api_key.as_deref(),
            );

            let mut api_stream = Box::pin(api_stream);
            while let Some(event) = api_stream.next().await {
                if sender.push(event).is_err() {
                    break;
                }
            }
        });

        stream
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_catalog() {
        let models = openai_models();
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.id == "gpt-4o"));
        assert!(models.iter().any(|m| m.id == "gpt-4o-mini"));
        assert!(models.iter().any(|m| m.id == "o3"));

        let gpt4o = models.iter().find(|m| m.id == "gpt-4o").unwrap();
        assert!(gpt4o.reasoning);
        assert_eq!(gpt4o.api, Api::OpenAiCompletions);
        assert_eq!(gpt4o.context_window, 128_000);
    }

    #[test]
    fn test_provider_identity() {
        let provider = OpenAIProvider::new();
        assert_eq!(provider.id(), "openai");
        assert_eq!(provider.name(), "OpenAI");
        assert!(provider.base_url().is_some());
        assert_eq!(provider.get_models().len(), 4);
    }
}
