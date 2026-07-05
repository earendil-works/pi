use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::openai_completions::{self, ThinkingFormat};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct".into(), name: "Llama 4 Maverick".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::HuggingFace), base_url: "https://router.huggingface.co/v1".into(), reasoning: false, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 0.20, output: 0.60, cache_read: 0.0, cache_write: 0.0 }, context_window: 128_000, max_tokens: 8_192, headers: HashMap::new() },
    Model { id: "deepseek-ai/DeepSeek-R1".into(), name: "DeepSeek R1".into(), api: Api::OpenAiCompletions, provider: ProviderId::Known(KnownProvider::HuggingFace), base_url: "https://router.huggingface.co/v1".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 3.0, output: 8.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 128_000, max_tokens: 32_768, headers: HashMap::new() },
]}

pub struct HuggingFaceProvider { auth: AuthMethod, models: Vec<Model> }
impl HuggingFaceProvider { pub fn new() -> Self { HuggingFaceProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "HuggingFace token".into(), env_vars: vec!["HF_TOKEN".into()] }), models: models() } } }
#[async_trait]
impl Provider for HuggingFaceProvider {
    fn id(&self) -> &str { "huggingface" } fn name(&self) -> &str { "HuggingFace" } fn base_url(&self) -> Option<&str> { Some("https://router.huggingface.co/v1") } fn headers(&self) -> Option<&ProviderHeaders> { None } fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.api_key.as_deref()),o.as_ref().and_then(|x|x.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::OpenAI); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set HF_TOKEN".to_string())}); } } }); s
    }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (s,tx)=create_event_stream(); let m=m.clone(); let c=c.clone(); let o=o.cloned(); let a=self.auth.clone();
        tokio::spawn(async move { let k=resolve_provider_auth(&a,o.as_ref().and_then(|x|x.base.api_key.as_deref()),o.as_ref().and_then(|x|x.base.env.as_ref())).await.ok().and_then(|r|r?.api_key); match k { Some(key) => { let api=openai_completions::stream_simple_with_format(&m,&c,o.as_ref(),Some(&key),ThinkingFormat::OpenAI); let mut a=Box::pin(api); while let Some(e)=a.next().await { if tx.push(e).is_err(){break;} } }, None => { let _=tx.push(AssistantMessageEvent::Error{reason:StopReason::Error,error:AssistantMessage::error(m.api,m.provider.clone(),&m.id,"Set HF_TOKEN".to_string())}); } } }); s
    }
}
#[cfg(test)] mod tests { use super::*; #[test] fn test_id() { assert_eq!(HuggingFaceProvider::new().id(),"huggingface"); } }
