use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::openai_completions::{self, ThinkingFormat};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "openai/gpt-4o".into(), name: "GPT-4o (OpenRouter)".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::OpenRouter), base_url: "https://openrouter.ai/api/v1".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text,InputModality::Image], cost: ModelCost { input: 2.50, output: 10.0, cache_read: 1.25, cache_write: 0.0 }, context_window: 128_000, max_tokens: 16_384, headers: HashMap::new() },
    Model { id: "anthropic/claude-sonnet-5".into(), name: "Claude Sonnet 5 (OpenRouter)".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::OpenRouter), base_url: "https://openrouter.ai/api/v1".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text,InputModality::Image], cost: ModelCost { input: 3.0, output: 15.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 200_000, max_tokens: 32_768, headers: HashMap::new() },
    Model { id: "google/gemini-2.5-pro".into(), name: "Gemini 2.5 Pro (OpenRouter)".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::OpenRouter), base_url: "https://openrouter.ai/api/v1".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text,InputModality::Image], cost: ModelCost { input: 1.25, output: 10.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 1_000_000, max_tokens: 64_000, headers: HashMap::new() },
]}

pub struct OpenRouterProvider { auth: AuthMethod, models: Vec<Model> }
impl OpenRouterProvider { pub fn new() -> Self { OpenRouterProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "OpenRouter API key".into(), env_vars: vec!["OPENROUTER_API_KEY".into()] }), models: models() } } }
#[async_trait]
impl Provider for OpenRouterProvider {
    fn id(&self) -> &str { "openrouter" } fn name(&self) -> &str { "OpenRouter" } fn base_url(&self) -> Option<&str> { Some("https://openrouter.ai/api/v1") } fn headers(&self) -> Option<&ProviderHeaders> { None } fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.api_key.as_deref()),o.as_ref().and_then(|x|x.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::OpenRouter); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set OPENROUTER_API_KEY".to_string())}); } } }); s
    }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.base.api_key.as_deref()),o.as_ref().and_then(|x|x.base.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_simple_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::OpenRouter); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set OPENROUTER_API_KEY".to_string())}); } } }); s
    }
}
#[cfg(test)] mod tests { use super::*; #[test] fn test_id() { assert_eq!(OpenRouterProvider::new().id(),"openrouter"); } }
