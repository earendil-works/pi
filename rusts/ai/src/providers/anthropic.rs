use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::anthropic_messages;
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

pub fn anthropic_models() -> Vec<Model> {
    vec![
        Model {
            id: "claude-sonnet-5".into(), name: "Claude Sonnet 5".into(),
            api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::Anthropic),
            base_url: "https://api.anthropic.com".into(), reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, Some("minimal".into()));
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m.insert(ThinkingLevel::XHigh, Some("xhigh".into()));
                m
            },
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: 0.30, cache_write: 6.0 },
            context_window: 200_000, max_tokens: 32_768, headers: HashMap::new(),
        },
        Model {
            id: "claude-haiku-4-5".into(), name: "Claude Haiku 4.5".into(),
            api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::Anthropic),
            base_url: "https://api.anthropic.com".into(), reasoning: true,
            thinking_level_map: HashMap::new(),
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost { input: 0.80, output: 4.0, cache_read: 0.08, cache_write: 1.60 },
            context_window: 200_000, max_tokens: 8_192, headers: HashMap::new(),
        },
        Model {
            id: "claude-opus-4-8".into(), name: "Claude Opus 4.8".into(),
            api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::Anthropic),
            base_url: "https://api.anthropic.com".into(), reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, Some("minimal".into()));
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m.insert(ThinkingLevel::XHigh, Some("xhigh".into()));
                m
            },
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost { input: 15.0, output: 75.0, cache_read: 1.50, cache_write: 30.0 },
            context_window: 200_000, max_tokens: 32_768, headers: HashMap::new(),
        },
        Model {
            id: "claude-fable-5".into(), name: "Claude Fable 5".into(),
            api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::Anthropic),
            base_url: "https://api.anthropic.com".into(), reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::Minimal, Some("minimal".into()));
                m.insert(ThinkingLevel::Low, Some("low".into()));
                m.insert(ThinkingLevel::Medium, Some("medium".into()));
                m.insert(ThinkingLevel::High, Some("high".into()));
                m.insert(ThinkingLevel::XHigh, Some("xhigh".into()));
                m
            },
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost { input: 3.0, output: 15.0, cache_read: 0.30, cache_write: 6.0 },
            context_window: 200_000, max_tokens: 32_768, headers: HashMap::new(),
        },
    ]
}

pub struct AnthropicProvider { auth: AuthMethod, models: Vec<Model> }

impl AnthropicProvider {
    pub fn new() -> Self {
        AnthropicProvider {
            auth: AuthMethod::ApiKey(ApiKeyAuth { name: "Anthropic API key".into(), env_vars: vec!["ANTHROPIC_API_KEY".into()] }),
            models: anthropic_models(),
        }
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn id(&self) -> &str { "anthropic" }
    fn name(&self) -> &str { "Anthropic" }
    fn base_url(&self) -> Option<&str> { Some("https://api.anthropic.com") }
    fn headers(&self) -> Option<&ProviderHeaders> { None }
    fn auth(&self) -> &AuthMethod { &self.auth }
    fn get_models(&self) -> &[Model] { &self.models }

    fn stream(&self, model: &Model, context: &Context, options: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (stream, sender) = create_event_stream();
        let owned_model = model.clone(); let owned_context = context.clone();
        let owned_options = options.cloned(); let auth = self.auth.clone();
        tokio::spawn(async move {
            let api_key = match resolve_provider_auth(&auth, owned_options.as_ref().and_then(|o| o.api_key.as_deref()), owned_options.as_ref().and_then(|o| o.env.as_ref())).await {
                Ok(Some(r)) => r.api_key, _ => {
                    let msg = AssistantMessage::error(owned_model.api, owned_model.provider.clone(), &owned_model.id, "Set ANTHROPIC_API_KEY".to_string());
                    let _ = sender.push(AssistantMessageEvent::Error { reason: StopReason::Error, error: msg }); return;
                }
            };
            let api_stream = anthropic_messages::stream(&owned_model, &owned_context, owned_options.as_ref(), api_key.as_deref());
            let mut api_stream = Box::pin(api_stream);
            while let Some(event) = api_stream.next().await { if sender.push(event).is_err() { break; } }
        }); stream
    }

    fn stream_simple(&self, model: &Model, context: &Context, options: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (stream, sender) = create_event_stream();
        let owned_model = model.clone(); let owned_context = context.clone();
        let owned_options = options.cloned(); let auth = self.auth.clone();
        tokio::spawn(async move {
            let api_key = match resolve_provider_auth(&auth, owned_options.as_ref().and_then(|o| o.base.api_key.as_deref()), owned_options.as_ref().and_then(|o| o.base.env.as_ref())).await {
                Ok(Some(r)) => r.api_key, _ => {
                    let msg = AssistantMessage::error(owned_model.api, owned_model.provider.clone(), &owned_model.id, "Set ANTHROPIC_API_KEY".to_string());
                    let _ = sender.push(AssistantMessageEvent::Error { reason: StopReason::Error, error: msg }); return;
                }
            };
            let api_stream = anthropic_messages::stream_simple(&owned_model, &owned_context, owned_options.as_ref(), api_key.as_deref());
            let mut api_stream = Box::pin(api_stream);
            while let Some(event) = api_stream.next().await { if sender.push(event).is_err() { break; } }
        }); stream
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn test_models() { assert!(anthropic_models().len() >= 4); }
    #[test] fn test_provider_id() { let p = AnthropicProvider::new(); assert_eq!(p.id(), "anthropic"); assert_eq!(p.get_models().len(), 4); }
}
