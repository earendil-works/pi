use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── API & Provider Identifiers ───────────────────────────────────────────────

/// Known API protocol types. Each API defines a wire protocol (REST schema, SSE format, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Api {
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "azure-openai-responses")]
    AzureOpenAiResponses,
    #[serde(rename = "openai-codex-responses")]
    OpenAiCodexResponses,
    #[serde(rename = "google-generative-ai")]
    GoogleGenerativeAi,
    #[serde(rename = "google-vertex")]
    GoogleVertex,
    #[serde(rename = "mistral-conversations")]
    MistralConversations,
    #[serde(rename = "bedrock-converse-stream")]
    BedrockConverseStream,
}

impl Api {
    pub fn as_str(&self) -> &'static str {
        match self {
            Api::OpenAiCompletions => "openai-completions",
            Api::AnthropicMessages => "anthropic-messages",
            Api::OpenAiResponses => "openai-responses",
            Api::AzureOpenAiResponses => "azure-openai-responses",
            Api::OpenAiCodexResponses => "openai-codex-responses",
            Api::GoogleGenerativeAi => "google-generative-ai",
            Api::GoogleVertex => "google-vertex",
            Api::MistralConversations => "mistral-conversations",
            Api::BedrockConverseStream => "bedrock-converse-stream",
        }
    }
}

/// Known image-generation API types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ImagesApi {
    #[serde(rename = "openrouter-images")]
    OpenRouterImages,
}

/// Known provider identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KnownProvider {
    #[serde(rename = "amazon-bedrock")]
    AmazonBedrock,
    Anthropic,
    Google,
    #[serde(rename = "google-vertex")]
    GoogleVertex,
    OpenAI,
    #[serde(rename = "azure-openai-responses")]
    AzureOpenAiResponses,
    #[serde(rename = "openai-codex")]
    OpenAiCodex,
    #[serde(rename = "github-copilot")]
    GitHubCopilot,
    Xai,
    Groq,
    Cerebras,
    OpenRouter,
    #[serde(rename = "vercel-ai-gateway")]
    VercelAiGateway,
    Mistral,
    HuggingFace,
    Fireworks,
    Together,
    Nvidia,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "kimi-coding")]
    KimiCoding,
    Minimax,
    #[serde(rename = "minimax-cn")]
    MinimaxCN,
    #[serde(rename = "moonshotai")]
    MoonshotAI,
    #[serde(rename = "moonshotai-cn")]
    MoonshotAICN,
    #[serde(rename = "ant-ling")]
    AntLing,
}

impl KnownProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            KnownProvider::AmazonBedrock => "amazon-bedrock",
            KnownProvider::Anthropic => "anthropic",
            KnownProvider::Google => "google",
            KnownProvider::GoogleVertex => "google-vertex",
            KnownProvider::OpenAI => "openai",
            KnownProvider::AzureOpenAiResponses => "azure-openai-responses",
            KnownProvider::OpenAiCodex => "openai-codex",
            KnownProvider::DeepSeek => "deepseek",
            KnownProvider::GitHubCopilot => "github-copilot",
            KnownProvider::Xai => "xai",
            KnownProvider::Groq => "groq",
            KnownProvider::Cerebras => "cerebras",
            KnownProvider::OpenRouter => "openrouter",
            KnownProvider::VercelAiGateway => "vercel-ai-gateway",
            KnownProvider::Mistral => "mistral",
            KnownProvider::HuggingFace => "huggingface",
            KnownProvider::Fireworks => "fireworks",
            KnownProvider::Together => "together",
            KnownProvider::Nvidia => "nvidia",
            KnownProvider::KimiCoding => "kimi-coding",
            KnownProvider::Minimax => "minimax",
            KnownProvider::MinimaxCN => "minimax-cn",
            KnownProvider::MoonshotAI => "moonshotai",
            KnownProvider::MoonshotAICN => "moonshotai-cn",
            KnownProvider::AntLing => "ant-ling",
        }
    }
}

/// A provider identifier — either a known built-in or a custom string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProviderId {
    Known(KnownProvider),
    Custom(String),
}

impl ProviderId {
    pub fn as_str(&self) -> &str {
        match self {
            ProviderId::Known(k) => k.as_str(),
            ProviderId::Custom(s) => s.as_str(),
        }
    }
}

impl From<KnownProvider> for ProviderId {
    fn from(k: KnownProvider) -> Self {
        ProviderId::Known(k)
    }
}

impl From<&str> for ProviderId {
    fn from(s: &str) -> Self {
        match s {
            "amazon-bedrock" => ProviderId::Known(KnownProvider::AmazonBedrock),
            "anthropic" => ProviderId::Known(KnownProvider::Anthropic),
            "google" => ProviderId::Known(KnownProvider::Google),
            "google-vertex" => ProviderId::Known(KnownProvider::GoogleVertex),
            "openai" => ProviderId::Known(KnownProvider::OpenAI),
            "azure-openai-responses" => ProviderId::Known(KnownProvider::AzureOpenAiResponses),
            "openai-codex" => ProviderId::Known(KnownProvider::OpenAiCodex),
            "deepseek" => ProviderId::Known(KnownProvider::DeepSeek),
            "github-copilot" => ProviderId::Known(KnownProvider::GitHubCopilot),
            "xai" => ProviderId::Known(KnownProvider::Xai),
            "groq" => ProviderId::Known(KnownProvider::Groq),
            "cerebras" => ProviderId::Known(KnownProvider::Cerebras),
            "openrouter" => ProviderId::Known(KnownProvider::OpenRouter),
            "vercel-ai-gateway" => ProviderId::Known(KnownProvider::VercelAiGateway),
            "mistral" => ProviderId::Known(KnownProvider::Mistral),
            "huggingface" => ProviderId::Known(KnownProvider::HuggingFace),
            "fireworks" => ProviderId::Known(KnownProvider::Fireworks),
            "together" => ProviderId::Known(KnownProvider::Together),
            "nvidia" => ProviderId::Known(KnownProvider::Nvidia),
            other => ProviderId::Custom(other.to_string()),
        }
    }
}

// ─── Thinking / Reasoning ─────────────────────────────────────────────────────

/// Thinking effort levels, paralleling the TS `ThinkingLevel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
}

impl ThinkingLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ThinkingLevel::Off => "off",
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
            ThinkingLevel::XHigh => "xhigh",
        }
    }
}

/// Maps pi thinking levels to provider/model-specific values.
/// `None` marks a level as unsupported.
pub type ThinkingLevelMap = HashMap<ThinkingLevel, Option<String>>;

/// Supported thinking levels for a model in priority order.
pub const EXTENDED_THINKING_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];

// ─── Transport ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Sse,
    Websocket,
    #[serde(rename = "websocket-cached")]
    WebsocketCached,
    Auto,
}

// ─── Cache Retention ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheRetention {
    None,
    Short,
    Long,
}

// ─── Cost ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelCost {
    /// USD per million input tokens
    pub input: f64,
    /// USD per million output tokens
    pub output: f64,
    /// USD per million cache-read tokens
    pub cache_read: f64,
    /// USD per million cache-write tokens
    pub cache_write: f64,
}

/// Computed cost for a single request.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

/// Token usage + cost. Mirrors the TS `Usage`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Subset of `cache_write` written with 1h retention (Anthropic).
    pub cache_write_1h: Option<u64>,
    /// Reasoning/thinking tokens — subset of `output`.
    pub reasoning: Option<u64>,
    pub total_tokens: u64,
    pub cost: CostBreakdown,
}

impl Usage {
    /// Calculate cost from a model's rate card. Matches TS `calculateCost()`.
    pub fn calculate_cost(&mut self, model_cost: &ModelCost) {
        let long_write = self.cache_write_1h.unwrap_or(0);
        let short_write = self.cache_write.saturating_sub(long_write);

        self.cost.input = (model_cost.input / 1_000_000.0) * self.input as f64;
        self.cost.output = (model_cost.output / 1_000_000.0) * self.output as f64;
        self.cost.cache_read = (model_cost.cache_read / 1_000_000.0) * self.cache_read as f64;
        // Anthropic charges 2× base input for 1h cache writes
        self.cost.cache_write =
            (model_cost.cache_write * short_write as f64 + model_cost.input * 2.0 * long_write as f64) / 1_000_000.0;
        self.cost.total = self.cost.input + self.cost.output + self.cost.cache_read + self.cost.cache_write;
    }
}

// ─── Content Blocks ────────────────────────────────────────────────────────────

/// A text signature, matching TS `TextSignatureV1`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextSignatureV1 {
    pub v: u8,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThinkingContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub thinking: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    /// When true, thinking was redacted by safety filters.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageContent {
    #[serde(rename = "type")]
    pub content_type: String,
    /// Base64-encoded image data.
    pub data: String,
    /// e.g. "image/jpeg", "image/png"
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(rename = "type")]
    pub content_type: String,
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// Google-specific: opaque signature for reusing thought context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

/// A content block within a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Content {
    #[serde(rename = "text")]
    Text(TextContent),
    #[serde(rename = "thinking")]
    Thinking(ThinkingContent),
    #[serde(rename = "image")]
    Image(ImageContent),
    #[serde(rename = "toolCall")]
    ToolCall(Box<ToolCall>),
}

impl Content {
    pub fn text(text: impl Into<String>) -> Self {
        Content::Text(TextContent {
            content_type: "text".into(),
            text: text.into(),
            text_signature: None,
        })
    }

    pub fn image(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Content::Image(ImageContent {
            content_type: "image".into(),
            data: data.into(),
            mime_type: mime_type.into(),
        })
    }
}

// ─── Stop Reason ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

// ─── Messages ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    #[serde(skip, default)]
    pub role: String,
    pub content: UserMessageContent,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserMessageContent {
    Text(String),
    Array(Vec<Content>),
}

impl UserMessage {
    pub fn new(content: UserMessageContent) -> Self {
        UserMessage {
            role: "user".into(),
            content,
            timestamp: Utc::now().timestamp_millis(),
        }
    }

    pub fn text(text: impl Into<String>) -> Self {
        Self::new(UserMessageContent::Text(text.into()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    #[serde(skip, default)]
    pub role: String,
    pub content: Vec<Content>,
    pub api: Api,
    pub provider: ProviderId,
    pub model: String,
    /// Concrete model when different from requested (e.g. OpenRouter `auto`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Provider-specific response/message identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    pub usage: Usage,
    pub stop_reason: StopReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

impl AssistantMessage {
    /// Create a zero-usage error message for setup/configuration failures.
    pub fn error(
        api: Api,
        provider: ProviderId,
        model_id: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Self {
        AssistantMessage {
            role: "assistant".into(),
            content: vec![],
            api,
            provider,
            model: model_id.into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason: StopReason::Error,
            error_message: Some(error_message.into()),
            timestamp: Utc::now().timestamp_millis(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultMessage {
    #[serde(skip, default)]
    pub role: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub content: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    pub is_error: bool,
    /// Unix timestamp in milliseconds.
    pub timestamp: i64,
}

impl ToolResultMessage {
    pub fn new(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: Vec<Content>,
        is_error: bool,
    ) -> Self {
        ToolResultMessage {
            role: "toolResult".into(),
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            content,
            details: None,
            is_error,
            timestamp: Utc::now().timestamp_millis(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "user")]
    User(UserMessage),
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    #[serde(rename = "toolResult")]
    ToolResult(ToolResultMessage),
}

// ─── Context ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON Schema for tool parameters (serde_json::Value).
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Context {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Tool>,
}

impl Context {
    pub fn new() -> Self {
        Context::default()
    }

    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    pub fn with_messages(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }

    pub fn with_tools(mut self, tools: Vec<Tool>) -> Self {
        self.tools = tools;
        self
    }
}

// ─── Model ─────────────────────────────────────────────────────────────────────

/// A model descriptor — the central currency of the unified API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    /// Unique model identifier within the provider (e.g. "gpt-4o").
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// The API protocol this model uses.
    pub api: Api,
    /// The provider that serves this model.
    pub provider: ProviderId,
    /// Base URL for API requests.
    pub base_url: String,
    /// Whether the model supports reasoning/thinking.
    pub reasoning: bool,
    /// Maps thinking levels to provider-specific values.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub thinking_level_map: ThinkingLevelMap,
    /// Supported input modalities.
    #[serde(default)]
    pub input: Vec<InputModality>,
    /// Pricing.
    pub cost: ModelCost,
    /// Maximum context window in tokens.
    pub context_window: u64,
    /// Maximum output tokens.
    pub max_tokens: u64,
    /// Optional custom HTTP headers.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputModality {
    Text,
    Image,
}

impl Model {
    /// Get supported thinking levels, respecting the model's `thinking_level_map`.
    pub fn supported_thinking_levels(&self) -> Vec<ThinkingLevel> {
        if !self.reasoning {
            return vec![ThinkingLevel::Off];
        }

        EXTENDED_THINKING_LEVELS
            .iter()
            .filter(|&&level| {
                if let Some(mapped) = self.thinking_level_map.get(&level) {
                    // None in the map = explicitly unsupported
                    if mapped.is_none() {
                        return false;
                    }
                    // "xhigh" must have an explicit mapping
                    if level == ThinkingLevel::XHigh {
                        return mapped.is_some();
                    }
                    true
                } else {
                    // Not in map = supported with default mapping
                    level != ThinkingLevel::XHigh
                }
            })
            .copied()
            .collect()
    }

    /// Clamp a thinking level to the nearest supported level.
    pub fn clamp_thinking_level(&self, level: ThinkingLevel) -> ThinkingLevel {
        let available = self.supported_thinking_levels();
        if available.contains(&level) {
            return level;
        }

        let idx = EXTENDED_THINKING_LEVELS.iter().position(|&l| l == level);
        let idx = match idx {
            Some(i) => i,
            None => return available.first().copied().unwrap_or(ThinkingLevel::Off),
        };

        // Try higher levels first
        for i in idx..EXTENDED_THINKING_LEVELS.len() {
            if available.contains(&EXTENDED_THINKING_LEVELS[i]) {
                return EXTENDED_THINKING_LEVELS[i];
            }
        }
        // Then lower
        for i in (0..idx).rev() {
            if available.contains(&EXTENDED_THINKING_LEVELS[i]) {
                return EXTENDED_THINKING_LEVELS[i];
            }
        }

        available.first().copied().unwrap_or(ThinkingLevel::Off)
    }
}

// ─── Stream Options ────────────────────────────────────────────────────────────

pub type ProviderEnv = HashMap<String, String>;
pub type ProviderHeaders = HashMap<String, String>;

#[derive(Debug, Clone, Default)]
pub struct StreamOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
    pub signal: Option<()>, // placeholder for cancellation token
    pub api_key: Option<String>,
    pub transport: Option<Transport>,
    pub cache_retention: Option<CacheRetention>,
    pub session_id: Option<String>,
    pub headers: Option<ProviderHeaders>,
    pub timeout_ms: Option<u64>,
    pub websocket_connect_timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    pub max_retry_delay_ms: Option<u64>,
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    pub env: Option<ProviderEnv>,
}

/// Unified options with reasoning level — used by `stream_simple()`.
#[derive(Debug, Clone, Default)]
pub struct SimpleStreamOptions {
    pub base: StreamOptions,
    pub reasoning: Option<ThinkingLevel>,
    /// Custom token budgets for thinking levels (token-based providers only).
    pub thinking_budgets: Option<ThinkingBudgets>,
}

#[derive(Debug, Clone, Default)]
pub struct ThinkingBudgets {
    pub minimal: Option<u64>,
    pub low: Option<u64>,
    pub medium: Option<u64>,
    pub high: Option<u64>,
}

// ─── Provider Response ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ProviderResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
}

// ─── Event Stream ──────────────────────────────────────────────────────────────

/// Stream event protocol for `AssistantMessageEventStream`.
///
/// Matches the TS `AssistantMessageEvent` discriminated union.
#[derive(Debug, Clone)]
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
    ToolCallStart {
        content_index: usize,
        partial: AssistantMessage,
    },
    ToolCallDelta {
        content_index: usize,
        delta: String,
        partial: AssistantMessage,
    },
    ToolCallEnd {
        content_index: usize,
        tool_call: ToolCall,
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

impl AssistantMessageEvent {
    /// Returns true if this is a terminal event (Done or Error).
    pub fn is_terminal(&self) -> bool {
        matches!(self, AssistantMessageEvent::Done { .. } | AssistantMessageEvent::Error { .. })
    }
}

// ─── Image Generation Types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagesModel {
    pub id: String,
    pub name: String,
    pub api: ImagesApi,
    pub provider: ProviderId,
    pub base_url: String,
    pub output: Vec<OutputModality>,
    pub cost: ModelCost,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputModality {
    Text,
    Image,
}

#[derive(Debug, Clone)]
pub struct ImagesContext {
    pub input: Vec<Content>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImagesStopReason {
    Stop,
    Error,
    Aborted,
}

#[derive(Debug, Clone)]
pub struct AssistantImages {
    pub api: ImagesApi,
    pub provider: ProviderId,
    pub model: String,
    pub output: Vec<Content>,
    pub response_id: Option<String>,
    pub usage: Option<Usage>,
    pub stop_reason: ImagesStopReason,
    pub error_message: Option<String>,
    pub timestamp: i64,
}

impl Default for AssistantImages {
    fn default() -> Self {
        AssistantImages {
            api: ImagesApi::OpenRouterImages,
            provider: ProviderId::Known(KnownProvider::OpenRouter),
            model: String::new(),
            output: vec![],
            response_id: None,
            usage: None,
            stop_reason: ImagesStopReason::Stop,
            error_message: None,
            timestamp: Utc::now().timestamp_millis(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ImagesOptions {
    pub signal: Option<()>,
    pub api_key: Option<String>,
    pub env: Option<ProviderEnv>,
    pub headers: Option<ProviderHeaders>,
    pub timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
    pub max_retry_delay_ms: Option<u64>,
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_serde() {
        let msg = Message::User(UserMessage::text("Hello, world!"));
        let json = serde_json::to_string(&msg).unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        match back {
            Message::User(u) => match u.content {
                UserMessageContent::Text(t) => assert_eq!(t, "Hello, world!"),
                _ => panic!("expected Text variant"),
            },
            _ => panic!("expected User variant"),
        }
    }

    #[test]
    fn test_thinking_levels_default_model() {
        let model = Model {
            id: "gpt-4o".into(),
            name: "GPT-4o".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: true,
            thinking_level_map: HashMap::new(),
            input: vec![InputModality::Text, InputModality::Image],
            cost: ModelCost::default(),
            context_window: 128000,
            max_tokens: 16384,
            headers: HashMap::new(),
        };

        let levels = model.supported_thinking_levels();
        assert!(levels.contains(&ThinkingLevel::Off));
        assert!(levels.contains(&ThinkingLevel::Low));
        // xhigh should not be supported without explicit mapping
        assert!(!levels.contains(&ThinkingLevel::XHigh));
    }

    #[test]
    fn test_usage_cost_calculation() {
        let model_cost = ModelCost {
            input: 2.50,
            output: 10.0,
            cache_read: 1.25,
            cache_write: 3.75,
        };

        let mut usage = Usage {
            input: 1_000_000,
            output: 500_000,
            cache_read: 200_000,
            cache_write: 100_000,
            cache_write_1h: Some(50_000),
            reasoning: None,
            total_tokens: 1_500_000,
            cost: CostBreakdown::default(),
        };

        usage.calculate_cost(&model_cost);

        assert!((usage.cost.input - 2.50).abs() < 0.01);
        assert!((usage.cost.output - 5.0).abs() < 0.01);
        assert!((usage.cost.total - (usage.cost.input + usage.cost.output + usage.cost.cache_read + usage.cost.cache_write)).abs() < 0.001);
    }

    #[test]
    fn test_clamp_thinking_level() {
        let model = Model {
            id: "test".into(),
            name: "Test".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: String::new(),
            reasoning: true,
            thinking_level_map: {
                let mut m = HashMap::new();
                m.insert(ThinkingLevel::XHigh, None); // xhigh not supported
                m
            },
            input: vec![InputModality::Text],
            cost: ModelCost::default(),
            context_window: 128000,
            max_tokens: 4096,
            headers: HashMap::new(),
        };

        assert_eq!(model.clamp_thinking_level(ThinkingLevel::XHigh), ThinkingLevel::High);
        assert_eq!(model.clamp_thinking_level(ThinkingLevel::Low), ThinkingLevel::Low);
    }
}
