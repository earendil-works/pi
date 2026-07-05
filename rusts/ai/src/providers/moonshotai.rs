use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::openai_completions::{self, ThinkingFormat};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "moonshot-v1-8k".into(), name: "Moonshot v1 8K".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::MoonshotAI), base_url: "https://api.moonshot.ai/v1".into(), reasoning: false, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 0.50, output: 1.50, cache_read: 0.0, cache_write: 0.0 }, context_window: 8_192, max_tokens: 8_192, headers: HashMap::new() },
    Model { id: "moonshot-v1-128k".into(), name: "Moonshot v1 128K".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::MoonshotAI), base_url: "https://api.moonshot.ai/v1".into(), reasoning: false, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 6.0, output: 12.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 128_000, max_tokens: 8_192, headers: HashMap::new() },
]}

pub struct MoonshotAIProvider { auth: AuthMethod, models: Vec<Model> }
impl MoonshotAIProvider { pub fn new() -> Self { MoonshotAIProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "Moonshot API key".into(), env_vars: vec!["MOONSHOT_API_KEY".into()] }), models: models() } } }
#[async_trait]
impl Provider for MoonshotAIProvider {
    fn id(&self) -> &str { "moonshotai" } fn name(&self) -> &str { "Moonshot AI" } fn base_url(&self) -> Option<&str> { Some("https://api.moonshot.ai/v1") } fn headers(&self) -> Option<&ProviderHeaders> { None } fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.api_key.as_deref()),o.as_ref().and_then(|x|x.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::DeepSeek); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set MOONSHOT_API_KEY".to_string())}); } } }); s
    }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.base.api_key.as_deref()),o.as_ref().and_then(|x|x.base.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_simple_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::DeepSeek); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set MOONSHOT_API_KEY".to_string())}); } } }); s
    }
}
#[cfg(test)] mod tests { use super::*; #[test] fn test_id() { assert_eq!(MoonshotAIProvider::new().id(),"moonshotai"); } }
