use std::{collections::VecDeque, sync::Arc, time::Duration};

use async_stream::stream;
use async_trait::async_trait;
use parking_lot::Mutex;
use serde_json::Value;

use crate::{
    AiError, AssistantMessage, AssistantMessageEvent as Event, Content, Context, EventStream, InputKind, Model,
    ModelCost, Provider, ResolvedAuth, StopReason, StreamOptions,
};

#[derive(Clone)]
pub struct FauxProvider {
    id: String,
    models: Vec<Model>,
    responses: Arc<Mutex<VecDeque<AssistantMessage>>>,
    tokens_per_second: Option<u64>,
    call_count: Arc<Mutex<u64>>,
}

impl FauxProvider {
    #[must_use]
    pub fn new(id: impl Into<String>, models: Vec<Model>, tokens_per_second: Option<u64>) -> Self {
        Self {
            id: id.into(),
            models,
            responses: Arc::new(Mutex::new(VecDeque::new())),
            tokens_per_second,
            call_count: Arc::new(Mutex::new(0)),
        }
    }

    #[must_use]
    pub fn default_model(provider: &str, id: &str) -> Model {
        Model {
            id: id.into(),
            name: id.into(),
            api: "faux".into(),
            provider: provider.into(),
            base_url: String::new(),
            reasoning: true,
            input: vec![InputKind::Text, InputKind::Image],
            cost: ModelCost::default(),
            context_window: 128_000,
            max_tokens: 32_000,
            headers: Default::default(),
            sampling_params: Default::default(),
            compat: Default::default(),
            thinking_level_map: Default::default(),
        }
    }

    pub fn set_responses(&self, responses: impl IntoIterator<Item = AssistantMessage>) {
        *self.responses.lock() = responses.into_iter().collect();
    }

    pub fn append_response(&self, response: AssistantMessage) {
        self.responses.lock().push_back(response);
    }

    #[must_use]
    pub fn pending_response_count(&self) -> usize {
        self.responses.lock().len()
    }

    #[must_use]
    pub fn call_count(&self) -> u64 {
        *self.call_count.lock()
    }
}

#[async_trait]
impl Provider for FauxProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        "Faux"
    }

    fn models(&self) -> Vec<Model> {
        self.models.clone()
    }

    fn env_keys(&self) -> &[String] {
        &[]
    }

    async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
        _auth: ResolvedAuth,
    ) -> Result<EventStream, AiError> {
        *self.call_count.lock() += 1;
        let stream_model = model.clone();
        let mut message = self.responses.lock().pop_front().unwrap_or_else(|| {
            let mut message = AssistantMessage::empty(model);
            message.stop_reason = StopReason::Error;
            message.error_message = Some("No more faux responses queued".into());
            message
        });
        if message.usage.total_tokens == 0 {
            message.usage.input = crate::estimate_tokens(&context.messages);
            let output_chars: usize = message
                .content
                .iter()
                .map(|block| match block {
                    Content::Text { text, .. } => text.len(),
                    Content::Thinking { thinking, .. } => thinking.len(),
                    Content::ToolCall { arguments, .. } => arguments.to_string().len(),
                    Content::Image { .. } => 0,
                })
                .sum();
            message.usage.output = u64::try_from(output_chars.div_ceil(4)).unwrap_or(u64::MAX);
            message.usage.calculate_cost(&model.cost);
        }
        let delay = self
            .tokens_per_second
            .map(|rate| Duration::from_millis((1000 / rate.max(1)).max(1)));
        let cancellation = options.cancellation;
        Ok(Box::pin(stream! {
            let mut partial = AssistantMessage::empty(&stream_model);
            yield Event::Start { partial: partial.clone() };
            for block in &message.content {
                if cancellation.as_ref().is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                    partial.stop_reason = StopReason::Aborted;
                    partial.error_message = Some("request aborted".into());
                    yield Event::Error { reason: StopReason::Aborted, error: partial };
                    return;
                }
                let index = partial.content.len();
                match block {
                    Content::Text { text, .. } => {
                        partial.content.push(Content::text(""));
                        yield Event::TextStart { content_index: index, partial: partial.clone() };
                        for chunk in chunks(text) {
                            if let Content::Text { text, .. } = &mut partial.content[index] {
                                text.push_str(chunk);
                            }
                            yield Event::TextDelta { content_index: index, delta: chunk.to_owned(), partial: partial.clone() };
                            if let Some(delay) = delay { tokio::time::sleep(delay).await; } else { tokio::task::yield_now().await; }
                        }
                        yield Event::TextEnd { content_index: index, content: text.clone(), partial: partial.clone() };
                    }
                    Content::Thinking { thinking, .. } => {
                        partial.content.push(Content::thinking(""));
                        yield Event::ThinkingStart { content_index: index, partial: partial.clone() };
                        for chunk in chunks(thinking) {
                            if let Content::Thinking { thinking, .. } = &mut partial.content[index] {
                                thinking.push_str(chunk);
                            }
                            yield Event::ThinkingDelta { content_index: index, delta: chunk.to_owned(), partial: partial.clone() };
                            if let Some(delay) = delay { tokio::time::sleep(delay).await; } else { tokio::task::yield_now().await; }
                        }
                        yield Event::ThinkingEnd { content_index: index, content: thinking.clone(), partial: partial.clone() };
                    }
                    Content::ToolCall { id, name, arguments, .. } => {
                        partial.content.push(Content::tool_call(id, name, Value::Object(Default::default())));
                        yield Event::ToolcallStart { content_index: index, partial: partial.clone() };
                        let encoded = arguments.to_string();
                        for chunk in chunks(&encoded) {
                            yield Event::ToolcallDelta { content_index: index, delta: chunk.to_owned(), partial: partial.clone() };
                            tokio::task::yield_now().await;
                        }
                        partial.content[index] = block.clone();
                        yield Event::ToolcallEnd { content_index: index, tool_call: block.clone(), partial: partial.clone() };
                    }
                    Content::Image { .. } => partial.content.push(block.clone()),
                }
            }
            message.timestamp = chrono::Utc::now().timestamp_millis();
            if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
                yield Event::Error { reason: message.stop_reason, error: message };
            } else {
                yield Event::Done { reason: message.stop_reason, message };
            }
        }))
    }
}

fn chunks(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut start = 0;
    for (index, _) in text.char_indices().skip(1) {
        if index - start >= 16 {
            result.push(&text[start..index]);
            start = index;
        }
    }
    result.push(&text[start..]);
    result
}

#[must_use]
pub fn faux_text(text: impl Into<String>) -> Content {
    Content::text(text)
}

#[must_use]
pub fn faux_thinking(text: impl Into<String>) -> Content {
    Content::thinking(text)
}

#[must_use]
pub fn faux_tool_call(name: impl Into<String>, arguments: Value) -> Content {
    Content::tool_call(format!("call_{}", uuid::Uuid::new_v4()), name, arguments)
}

#[must_use]
pub fn faux_assistant_message(model: &Model, content: Vec<Content>, stop_reason: StopReason) -> AssistantMessage {
    let mut message = AssistantMessage::empty(model);
    message.content = content;
    message.stop_reason = stop_reason;
    message
}
