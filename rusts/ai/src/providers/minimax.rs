use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::anthropic_messages;
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "minimax-m1".into(), name: "MiniMax M1".into(), api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::Minimax), base_url: "https://api.minimax.io/anthropic".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 0.50, output: 2.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 1_000_000, max_tokens: 32_768, headers: HashMap::new() },
]}

pub struct MinimaxProvider { auth: AuthMethod, models: Vec<Model> }
impl MinimaxProvider { pub fn new() -> Self { MinimaxProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "MiniMax API key".into(), env_vars: vec!["MINIMAX_API_KEY".into()] }), models: models() } } }

#[async_trait]
impl Provider for MinimaxProvider {
    fn id(&self) -> &str { "minimax" } fn name(&self) -> &str { "MiniMax" }
    fn base_url(&self) -> Option<&str> { Some("https://api.minimax.io/anthropic") } fn headers(&self) -> Option<&ProviderHeaders> { None }
    fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream {
        let (s, sender) = create_event_stream(); let m = m.clone(); let c = c.clone(); let o = o.cloned(); let a = self.auth.clone();
        tokio::spawn(async move {
            let key = resolve_provider_auth(&a, o.as_ref().and_then(|x| x.api_key.as_deref()), o.as_ref().and_then(|x| x.env.as_ref())).await.ok().and_then(|r| r?.api_key);
            match key { Some(k) => { let api = anthropic_messages::stream(&m, &c, o.as_ref(), Some(&k)); let mut api = Box::pin(api); while let Some(e) = api.next().await { if sender.push(e).is_err() { break; } } }, None => { let _ = sender.push(AssistantMessageEvent::Error { reason: StopReason::Error, error: AssistantMessage::error(m.api, m.provider.clone(), &m.id, "Set MINIMAX_API_KEY".to_string()) }); } }
        }); s
    }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream {
        let (s, sender) = create_event_stream(); let m = m.clone(); let c = c.clone(); let o = o.cloned(); let a = self.auth.clone();
        tokio::spawn(async move {
            let key = resolve_provider_auth(&a, o.as_ref().and_then(|x| x.base.api_key.as_deref()), o.as_ref().and_then(|x| x.base.env.as_ref())).await.ok().and_then(|r| r?.api_key);
            match key { Some(k) => { let api = anthropic_messages::stream_simple(&m, &c, o.as_ref(), Some(&k)); let mut api = Box::pin(api); while let Some(e) = api.next().await { if sender.push(e).is_err() { break; } } }, None => { let _ = sender.push(AssistantMessageEvent::Error { reason: StopReason::Error, error: AssistantMessage::error(m.api, m.provider.clone(), &m.id, "Set MINIMAX_API_KEY".to_string()) }); } }
        }); s
    }
}

#[cfg(test)] mod tests { use super::*; #[test] fn test_id() { assert_eq!(MinimaxProvider::new().id(), "minimax"); } }
