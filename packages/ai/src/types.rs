use std::{collections::BTreeMap, pin::Pin};

use futures::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Api = String;
pub type ProviderId = String;
pub type EventStream = Pin<Box<dyn Stream<Item = AssistantMessageEvent> + Send>>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    #[default]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheRetention {
    None,
    #[default]
    Short,
    Long,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    Sse,
    Websocket,
    WebsocketCached,
    #[default]
    Auto,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<ModelCostTier>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostTier {
    pub input_tokens_above: u64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: String,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<InputKind>,
    #[serde(default)]
    pub cost: ModelCost,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sampling_params: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub compat: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub thinking_level_map: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputKind {
    #[default]
    Text,
    Image,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(rename = "textSignature", skip_serializing_if = "Option::is_none")]
        text_signature: Option<String>,
    },
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        #[serde(rename = "thinkingSignature", skip_serializing_if = "Option::is_none")]
        thinking_signature: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        redacted: bool,
    },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    #[serde(rename = "toolCall")]
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
        #[serde(rename = "thoughtSignature", skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
    },
}

impl Content {
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text {
            text: text.into(),
            text_signature: None,
        }
    }

    #[must_use]
    pub fn thinking(thinking: impl Into<String>) -> Self {
        Self::Thinking {
            thinking: thinking.into(),
            thinking_signature: None,
            redacted: false,
        }
    }

    #[must_use]
    pub fn tool_call(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self::ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            thought_signature: None,
            namespace: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Blocks(Vec<Content>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "user")]
    User { content: UserContent, timestamp: i64 },
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(flatten)]
        message: AssistantMessage,
    },
    #[serde(rename = "toolResult")]
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        content: Vec<Content>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(rename = "addedToolNames", default, skip_serializing_if = "Vec::is_empty")]
        added_tool_names: Vec<String>,
        #[serde(rename = "isError")]
        is_error: bool,
        timestamp: i64,
    },
}

impl Message {
    #[must_use]
    pub fn user(text: impl Into<String>) -> Self {
        Self::User {
            content: UserContent::Text(text.into()),
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageCost {
    pub input: f64,
    pub output: f64,
    #[serde(rename = "cacheRead")]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
    pub total: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_1h: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<u64>,
    pub total_tokens: u64,
    pub cost: UsageCost,
}

impl Usage {
    pub fn calculate_cost(&mut self, rates: &ModelCost) {
        let tier = rates
            .tiers
            .iter()
            .filter(|tier| self.input > tier.input_tokens_above)
            .max_by_key(|tier| tier.input_tokens_above);
        let (input, output, cache_read, cache_write) = tier.map_or(
            (rates.input, rates.output, rates.cache_read, rates.cache_write),
            |tier| (tier.input, tier.output, tier.cache_read, tier.cache_write),
        );
        self.cost.input = self.input as f64 * input / 1_000_000.0;
        self.cost.output = self.output as f64 * output / 1_000_000.0;
        self.cost.cache_read = self.cache_read as f64 * cache_read / 1_000_000.0;
        self.cost.cache_write = self.cache_write as f64 * cache_write / 1_000_000.0;
        self.cost.total = self.cost.input + self.cost.output + self.cost.cache_read + self.cost.cache_write;
        self.total_tokens = self.input + self.output + self.cache_read + self.cache_write;
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Pending,
    #[default]
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub content: Vec<Content>,
    pub api: String,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_thinking_level: Option<String>,
    pub usage: Usage,
    pub stop_reason: StopReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_turn: Option<bool>,
    pub timestamp: i64,
}

impl AssistantMessage {
    #[must_use]
    pub fn empty(model: &Model) -> Self {
        Self {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            provider_thinking_level: None,
            usage: Usage::default(),
            stop_reason: StopReason::Pending,
            error_message: None,
            raw_stop_reason: None,
            end_turn: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }

    #[must_use]
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| match block {
                Content::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constrained_sampling: Option<ConstrainedSampling>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConstrainedSampling {
    JsonSchema { strict: StrictMode },
    Grammar { variants: BTreeMap<String, String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrictMode {
    Prefer,
    Require,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Tool>,
}

#[derive(Clone, Debug, Default)]
pub struct StreamOptions {
    pub cancellation: Option<tokio_util::sync::CancellationToken>,
    pub api_key: Option<String>,
    pub headers: BTreeMap<String, Option<String>>,
    pub env: BTreeMap<String, String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub reasoning: ThinkingLevel,
    pub thinking_budgets: BTreeMap<String, u64>,
    pub transport: Transport,
    pub cache_retention: CacheRetention,
    pub session_id: Option<String>,
    pub timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    pub metadata: BTreeMap<String, Value>,
    pub sampling_params: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AssistantMessageEvent {
    Start {
        partial: AssistantMessage,
    },
    TextStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    TextDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    TextEnd {
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ThinkingStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ThinkingDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ThinkingEnd {
        content_index: usize,
        content: String,
        partial: AssistantMessage,
    },
    ToolcallStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolcallDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ToolcallEnd {
        content_index: usize,
        tool_call: Content,
        partial: AssistantMessage,
    },
    Done {
        reason: StopReason,
        message: AssistantMessage,
    },
    Error {
        reason: StopReason,
        error: AssistantMessage,
    },
}
