use std::collections::HashMap;

use async_trait::async_trait;
use futures::StreamExt;

use crate::api::openai_completions;
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

// ─── Model Catalog ─────────────────────────────────────────────────────────────

/// Return the static model catalog for DeepSeek models.
pub fn deepseek_models() -> Vec<Model> {
    vec![
        Model {
            id: "deepseek-v4-flash".into(),
            name: "DeepSeek V4 Flash".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::DeepSeek),
            base_url: "https://api.deepseek.com".into(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, None); // disabled
                m.insert(ThinkingLevel::Low, None); // disabled
                m.insert(ThinkingLevel::Medium, None); // disabled
                m.insert(ThinkingLevel::High, Some("high".into()));
                m.insert(ThinkingLevel::XHigh, Some("max".into()));
                m
            },
            input: vec![InputModality::Text],
            cost: ModelCost {
                input: 0.14,
                output: 0.28,
                cache_read: 0.0028,
                cache_write: 0.0,
            },
            context_window: 1_000_000,
            max_tokens: 384_000,
            headers: HashMap::new(),
        },
        Model {
            id: "deepseek-v4-pro".into(),
            name: "DeepSeek V4 Pro".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::DeepSeek),
            base_url: "https://api.deepseek.com".into(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, None);
                m.insert(ThinkingLevel::Low, None);
                m.insert(ThinkingLevel::Medium, None);
                m.insert(ThinkingLevel::High, Some("high".into()));
                m.insert(ThinkingLevel::XHigh, Some("max".into()));
                m
            },
            input: vec![InputModality::Text],
            cost: ModelCost {
                input: 0.435,
                output: 0.87,
                cache_read: 0.003625,
                cache_write: 0.0,
            },
            context_window: 1_000_000,
            max_tokens: 384_000,
            headers: HashMap::new(),
        },
    ]
}

// ─── DeepSeek Provider ─────────────────────────────────────────────────────────

/// The DeepSeek provider, implementing the `Provider` trait.
///
/// DeepSeek uses an OpenAI-compatible completions API with a distinct
/// thinking format: `thinking: { type: "enabled"|"disabled" }` at the
/// top level, plus optional `reasoning_effort`.
pub struct DeepSeekProvider {
    auth: AuthMethod,
    models: Vec<Model>,
}

impl DeepSeekProvider {
    /// Create a new DeepSeek provider with the default static model catalog.
    pub fn new() -> Self {
        DeepSeekProvider {
            auth: AuthMethod::ApiKey(ApiKeyAuth {
                name: "DeepSeek API key".into(),
                env_vars: vec!["DEEPSEEK_API_KEY".into()],
            }),
            models: deepseek_models(),
        }
    }
}

impl Default for DeepSeekProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for DeepSeekProvider {
    fn id(&self) -> &str {
        "deepseek"
    }

    fn name(&self) -> &str {
        "DeepSeek"
    }

    fn base_url(&self) -> Option<&str> {
        Some("https://api.deepseek.com")
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
                        format!("No API key configured for {}. Set DEEPSEEK_API_KEY.", owned_model.provider.as_str()),
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

            let api_stream = openai_completions::stream_with_format(
                &owned_model,
                &owned_context,
                owned_options.as_ref(),
                api_key.as_deref(),
                openai_completions::ThinkingFormat::DeepSeek,
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
                        format!("No API key configured for {}. Set DEEPSEEK_API_KEY.", owned_model.provider.as_str()),
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

            let api_stream = openai_completions::stream_simple_with_format(
                &owned_model,
                &owned_context,
                owned_options.as_ref(),
                api_key.as_deref(),
                openai_completions::ThinkingFormat::DeepSeek,
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
        let models = deepseek_models();
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|m| m.id == "deepseek-v4-flash"));
        assert!(models.iter().any(|m| m.id == "deepseek-v4-pro"));

        let flash = models.iter().find(|m| m.id == "deepseek-v4-flash").unwrap();
        assert!(flash.reasoning);
        assert_eq!(flash.api, Api::OpenAiCompletions);
        assert_eq!(flash.context_window, 1_000_000);
        assert_eq!(flash.max_tokens, 384_000);
    }

    #[test]
    fn test_thinking_level_map() {
        let models = deepseek_models();
        let pro = models.iter().find(|m| m.id == "deepseek-v4-pro").unwrap();
        let levels = pro.supported_thinking_levels();

        // Minimal, Low, Medium should be disabled (null in map)
        assert!(!levels.contains(&ThinkingLevel::Minimal));
        assert!(!levels.contains(&ThinkingLevel::Low));
        assert!(!levels.contains(&ThinkingLevel::Medium));
        // High and XHigh should be enabled
        assert!(levels.contains(&ThinkingLevel::High));
        assert!(levels.contains(&ThinkingLevel::XHigh));
    }

    #[test]
    fn test_provider_identity() {
        let provider = DeepSeekProvider::new();
        assert_eq!(provider.id(), "deepseek");
        assert_eq!(provider.name(), "DeepSeek");
        assert_eq!(provider.base_url(), Some("https://api.deepseek.com"));
        assert_eq!(provider.get_models().len(), 2);
    }
}
