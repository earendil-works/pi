use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::openai_completions::{self, ThinkingFormat};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "ant-ling-8b".into(), name: "Ant Ling 8B".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::AntLing), base_url: "https://api.ant-ling.com/v1".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 0.07, output: 0.56, cache_read: 0.0, cache_write: 0.0 }, context_window: 128_000, max_tokens: 8_192, headers: HashMap::new() },
]}

pub struct AntLingProvider { auth: AuthMethod, models: Vec<Model> }
impl AntLingProvider { pub fn new() -> Self { AntLingProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "Ant Ling API key".into(), env_vars: vec!["ANT_LING_API_KEY".into()] }), models: models() } } }
#[async_trait]
impl Provider for AntLingProvider {
    fn id(&self) -> &str { "ant-ling" } fn name(&self) -> &str { "Ant Ling" } fn base_url(&self) -> Option<&str> { Some("https://api.ant-ling.com/v1") } fn headers(&self) -> Option<&ProviderHeaders> { None } fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.api_key.as_deref()),o.as_ref().and_then(|x|x.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::AntLing); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set ANT_LING_API_KEY".to_string())}); } } }); s
    }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.base.api_key.as_deref()),o.as_ref().and_then(|x|x.base.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_simple_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::AntLing); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set ANT_LING_API_KEY".to_string())}); } } }); s
    }
}
#[cfg(test)] mod tests { use super::*; #[test] fn test_id() { assert_eq!(AntLingProvider::new().id(),"ant-ling"); } }
