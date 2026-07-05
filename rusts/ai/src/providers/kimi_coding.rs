use std::collections::HashMap;
use async_trait::async_trait;
use futures::StreamExt;
use crate::api::anthropic_messages;
use crate::event_stream::{create_event_stream, AssistantMessageEventStream};
use crate::models::{resolve_provider_auth, ApiKeyAuth, AuthMethod, Provider};
use crate::types::*;

fn models() -> Vec<Model> { vec![
    Model { id: "kimi-for-coding".into(), name: "Kimi For Coding".into(), api: Api::AnthropicMessages, provider: ProviderId::Known(KnownProvider::KimiCoding), base_url: "https://api.kimi.com/coding".into(), reasoning: true, thinking_level_map: HashMap::new(), input: vec![InputModality::Text], cost: ModelCost { input: 0.50, output: 2.0, cache_read: 0.0, cache_write: 0.0 }, context_window: 128_000, max_tokens: 8_192, headers: HashMap::new() },
]}

pub struct KimiCodingProvider { auth: AuthMethod, models: Vec<Model> }
impl KimiCodingProvider { pub fn new() -> Self { KimiCodingProvider { auth: AuthMethod::ApiKey(ApiKeyAuth { name: "Kimi API key".into(), env_vars: vec!["KIMI_API_KEY".into()] }), models: models() } } }

#[async_trait]
impl Provider for KimiCodingProvider {
    fn id(&self) -> &str { "kimi-coding" } fn name(&self) -> &str { "Kimi For Coding" }
    fn base_url(&self) -> Option<&str> { Some("https://api.kimi.com/coding") } fn headers(&self) -> Option<&ProviderHeaders> { None }
    fn auth(&self) -> &AuthMethod { &self.auth } fn get_models(&self) -> &[Model] { &self.models }
    fn stream(&self, m: &Model, c: &Context, o: Option<&StreamOptions>) -> AssistantMessageEventStream { stream_impl(m, c, o, &self.auth) }
    fn stream_simple(&self, m: &Model, c: &Context, o: Option<&SimpleStreamOptions>) -> AssistantMessageEventStream { stream_simple_impl(m, c, o, &self.auth) }
}

fn stream_impl(model: &Model, context: &Context, options: Option<&StreamOptions>, auth: &AuthMethod) -> AssistantMessageEventStream {
    let (s, sender) = create_event_stream(); let m = model.clone(); let c = context.clone(); let o = options.cloned(); let a = auth.clone();
    tokio::spawn(async move {
        let key = auth_key(&a, &o).await; if key.is_none() { error_out(&sender, &m, "Set KIMI_API_KEY".to_string()); return; }
        let api = anthropic_messages::stream(&m, &c, o.as_ref(), key.as_deref());
        forward(api, sender).await;
    }); s
}

fn stream_simple_impl(model: &Model, context: &Context, options: Option<&SimpleStreamOptions>, auth: &AuthMethod) -> AssistantMessageEventStream {
    let (s, sender) = create_event_stream(); let m = model.clone(); let c = context.clone(); let o = options.cloned(); let a = auth.clone();
    tokio::spawn(async move {
        let key = match resolve_provider_auth(&a, o.as_ref().and_then(|x| x.base.api_key.as_deref()), o.as_ref().and_then(|x| x.base.env.as_ref())).await { Ok(Some(r)) => r.api_key, _ => { error_out(&sender, &m, "Set KIMI_API_KEY".to_string()); return; } };
        let api = anthropic_messages::stream_simple(&m, &c, o.as_ref(), key.as_deref());
        forward(api, sender).await;
    }); s
}

async fn auth_key(auth: &AuthMethod, opts: &Option<StreamOptions>) -> Option<String> {
    resolve_provider_auth(auth, opts.as_ref().and_then(|o| o.api_key.as_deref()), opts.as_ref().and_then(|o| o.env.as_ref())).await.ok().and_then(|r| r?.api_key)
}

fn error_out(sender: &crate::event_stream::EventStreamSender, model: &Model, msg: String) {
    let _ = sender.push(AssistantMessageEvent::Error { reason: StopReason::Error, error: AssistantMessage::error(model.api, model.provider.clone(), &model.id, msg) });
}

async fn forward(api: AssistantMessageEventStream, sender: crate::event_stream::EventStreamSender) {
    let mut api = Box::pin(api);
    while let Some(e) = api.next().await { if sender.push(e).is_err() { break; } }
}

#[cfg(test)] mod tests { use super::*; #[test] fn test_models() { assert!(!models().is_empty()); } #[test] fn test_id() { assert_eq!(KimiCodingProvider::new().id(), "kimi-coding"); } }
