use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AiError, Result};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream, EventStreamSender};
use crate::types::*;

// ─── Thinking Format ───────────────────────────────────────────────────────────

/// Controls how reasoning/thinking is communicated to the API.
///
/// Different providers use different conventions for the thinking parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingFormat {
    /// Standard OpenAI format: `reasoning_effort` field at top level.
    OpenAI,
    /// DeepSeek format: `thinking: { type: "enabled"|"disabled" }` + optional `reasoning_effort`.
    DeepSeek,
    /// Together format: `reasoning: { enabled: bool }` + optional `reasoning_effort`.
    Together,
    /// OpenRouter format: `reasoning: { effort }`.
    OpenRouter,
    /// AntLing format: `reasoning: { effort }` (only when mapped effort is non-null).
    AntLing,
}

// ─── OpenAI Request Types ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ChatTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    /// DeepSeek-style thinking control: `{ type: "enabled"|"disabled" }`
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingControl>,
    /// Together/OpenRouter/AntLing-style reasoning control: `{ enabled, effort }`
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    store: Option<bool>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptionsBody>,
}

#[derive(Debug, Serialize)]
struct ThinkingControl {
    #[serde(rename = "type")]
    thinking_type: String,
}

#[derive(Debug, Serialize)]
struct ReasoningControl {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
}

#[derive(Debug, Serialize)]
struct StreamOptionsBody {
    include_usage: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "role")]
enum ChatMessage {
    #[serde(rename = "system")]
    System {
        content: String,
    },
    #[serde(rename = "developer")]
    Developer {
        content: String,
    },
    #[serde(rename = "user")]
    User {
        content: ChatMessageContent,
    },
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ChatToolCall>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_content: Option<String>,
    },
    #[serde(rename = "tool")]
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ChatMessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl {
        image_url: ImageUrlPart,
    },
}

#[derive(Debug, Serialize)]
struct ImageUrlPart {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: ChatFunctionCall,
}

#[derive(Debug, Serialize)]
struct ChatFunctionCall {
    name: String,
    arguments: String,
}

#[derive(Debug, Serialize)]
struct ChatTool {
    #[serde(rename = "type")]
    tool_type: String,
    function: ChatFunctionDef,
}

#[derive(Debug, Serialize)]
struct ChatFunctionDef {
    name: String,
    description: String,
    parameters: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    strict: Option<bool>,
}

// ─── OpenAI Response (SSE delta) Types ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    id: Option<String>,
    object: Option<String>,
    created: Option<i64>,
    model: Option<String>,
    #[serde(default)]
    choices: Vec<ChoiceDelta>,
    #[serde(default)]
    usage: Option<CompletionUsage>,
}

#[derive(Debug, Deserialize)]
struct ChoiceDelta {
    index: u32,
    #[serde(default)]
    delta: Delta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDelta {
    index: u32,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "type")]
    call_type: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Debug, Deserialize, Default)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CompletionUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct CompletionTokensDetails {
    #[serde(default)]
    reasoning_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: u64,
}

// ─── Context → OpenAI Request Conversion ───────────────────────────────────────

fn thinking_level_to_reasoning_effort(level: ThinkingLevel) -> Option<&'static str> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Minimal => Some("minimal"),
        ThinkingLevel::Low => Some("low"),
        ThinkingLevel::Medium => Some("medium"),
        ThinkingLevel::High => Some("high"),
        ThinkingLevel::XHigh => Some("high"), // OpenAI maps xhigh → high
    }
}

fn convert_message(msg: &Message) -> Vec<ChatMessage> {
    match msg {
        Message::User(user) => {
            let content = match &user.content {
                UserMessageContent::Text(t) => ChatMessageContent::Text(t.clone()),
                UserMessageContent::Array(parts) => {
                    let content_parts: Vec<ContentPart> = parts
                        .iter()
                        .map(|c| match c {
                            Content::Text(t) => ContentPart::Text {
                                text: t.text.clone(),
                            },
                            Content::Image(img) => ContentPart::ImageUrl {
                                image_url: ImageUrlPart {
                                    url: format!("data:{};base64,{}", img.mime_type, img.data),
                                    detail: Some("auto".into()),
                                },
                            },
                            _ => ContentPart::Text {
                                text: "[unsupported content]".into(),
                            },
                        })
                        .collect();
                    ChatMessageContent::Parts(content_parts)
                }
            };
            vec![ChatMessage::User { content }]
        }
        Message::Assistant(assistant) => {
            let text_content: Vec<String> = assistant
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
                .collect();
            let tool_calls: Vec<ChatToolCall> = assistant
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::ToolCall(tc) => Some(ChatToolCall {
                        id: tc.id.clone(),
                        call_type: "function".into(),
                        function: ChatFunctionCall {
                            name: tc.name.clone(),
                            arguments: serde_json::to_string(&tc.arguments).unwrap_or_default(),
                        },
                    }),
                    _ => None,
                })
                .collect();
            let reasoning: Vec<String> = assistant
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::Thinking(t) => Some(t.thinking.clone()),
                    _ => None,
                })
                .collect();

            vec![ChatMessage::Assistant {
                content: if text_content.is_empty() {
                    None
                } else {
                    Some(text_content.join(""))
                },
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
                reasoning_content: if reasoning.is_empty() {
                    None
                } else {
                    Some(reasoning.join(""))
                },
            }]
        }
        Message::ToolResult(tr) => {
            let content_str: String = tr
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            vec![ChatMessage::Tool {
                tool_call_id: tr.tool_call_id.clone(),
                content: content_str,
            }]
        }
    }
}

fn convert_tools(tools: &[Tool]) -> Vec<ChatTool> {
    tools
        .iter()
        .map(|t| ChatTool {
            tool_type: "function".into(),
            function: ChatFunctionDef {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.parameters.clone(),
                strict: Some(true),
            },
        })
        .collect()
}

fn build_request(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    reasoning_effort: Option<String>,
    thinking_format: ThinkingFormat,
) -> ChatCompletionRequest {
    let mut messages: Vec<ChatMessage> = Vec::new();

    // System prompt
    if let Some(ref system_prompt) = context.system_prompt {
        messages.push(ChatMessage::Developer {
            content: system_prompt.clone(),
        });
    }

    // Convert conversation messages
    for msg in &context.messages {
        messages.extend(convert_message(msg));
    }

    let tools = if context.tools.is_empty() {
        None
    } else {
        Some(convert_tools(&context.tools))
    };

    let temperature = options.and_then(|o| o.temperature);
    let max_completion_tokens = options.and_then(|o| o.max_tokens);

    // Build thinking params based on format
    let (reasoning_effort, thinking, reasoning) = match thinking_format {
        ThinkingFormat::DeepSeek => {
            if reasoning_effort.is_some() {
                (
                    reasoning_effort.clone(),
                    Some(ThinkingControl { thinking_type: "enabled".into() }),
                    None,
                )
            } else {
                (None, Some(ThinkingControl { thinking_type: "disabled".into() }), None)
            }
        }
        ThinkingFormat::OpenAI => (reasoning_effort, None, None),
        ThinkingFormat::Together => {
            if let Some(ref effort) = reasoning_effort {
                (reasoning_effort.clone(), None, Some(ReasoningControl { enabled: Some(true), effort: Some(effort.clone()) }))
            } else {
                (None, None, Some(ReasoningControl { enabled: Some(false), effort: None }))
            }
        }
        ThinkingFormat::OpenRouter | ThinkingFormat::AntLing => {
            if let Some(ref effort) = reasoning_effort {
                (reasoning_effort.clone(), None, Some(ReasoningControl { enabled: None, effort: Some(effort.clone()) }))
            } else {
                (None, None, None)
            }
        }
    };

    ChatCompletionRequest {
        model: model.id.clone(),
        messages,
        tools,
        temperature,
        max_completion_tokens,
        reasoning_effort,
        thinking,
        reasoning,
        store: Some(false),
        stream: true,
        stream_options: Some(StreamOptionsBody {
            include_usage: true,
        }),
    }
}

// ─── SSE Stream Parser ─────────────────────────────────────────────────────────

fn parse_sse_line(line: &str) -> Option<ChatCompletionChunk> {
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" {
        return None;
    }
    serde_json::from_str(data).ok()
}

fn accumulate_events(
    chunk: ChatCompletionChunk,
    model: &Model,
    stream_model: &mut Option<String>,
    accumulated: &mut AssistantMessage,
    pending_tool_calls: &mut HashMap<u32, ToolCallAccumulator>,
    sender: &EventStreamSender,
) {
    // Track the response model
    if let Some(ref resp_model) = chunk.model {
        *stream_model = Some(resp_model.clone());
    }

    if let Some(ref id) = chunk.id {
        accumulated.response_id = Some(id.clone());
    }

    for choice in chunk.choices {
        let delta = choice.delta;

        // Handle reasoning/thinking
        if let Some(ref reasoning) = delta.reasoning_content {
            if !reasoning.is_empty() {
                // Find or create thinking content block
                let thinking_idx = accumulated
                    .content
                    .iter()
                    .position(|c| matches!(c, Content::Thinking { .. }));
                match thinking_idx {
                    Some(idx) => {
                        if let Content::Thinking(ref mut tc) = accumulated.content[idx] {
                            tc.thinking.push_str(reasoning);
                            let _ = sender.push(AssistantMessageEvent::ThinkingDelta {
                                content_index: idx,
                                delta: reasoning.clone(),
                                partial: accumulated.clone(),
                            });
                        }
                    }
                    None => {
                        let idx = accumulated.content.len();
                        accumulated.content.push(Content::Thinking(ThinkingContent {
                            content_type: "thinking".into(),
                            thinking: reasoning.clone(),
                            thinking_signature: None,
                            redacted: false,
                        }));
                        let _ = sender.push(AssistantMessageEvent::ThinkingStart {
                            content_index: idx,
                            partial: accumulated.clone(),
                        });
                        let _ = sender.push(AssistantMessageEvent::ThinkingDelta {
                            content_index: idx,
                            delta: reasoning.clone(),
                            partial: accumulated.clone(),
                        });
                    }
                }
            }
        }

        // Handle text content
        if let Some(ref text) = delta.content {
            if !text.is_empty() {
                let text_idx = accumulated
                    .content
                    .iter()
                    .position(|c| matches!(c, Content::Text { .. }));
                match text_idx {
                    Some(idx) => {
                        if let Content::Text(ref mut tc) = accumulated.content[idx] {
                            tc.text.push_str(text);
                            let _ = sender.push(AssistantMessageEvent::TextDelta {
                                content_index: idx,
                                delta: text.clone(),
                                partial: accumulated.clone(),
                            });
                        }
                    }
                    None => {
                        let idx = accumulated.content.len();
                        accumulated.content.push(Content::Text(TextContent {
                            content_type: "text".into(),
                            text: text.clone(),
                            text_signature: None,
                        }));
                        let _ = sender.push(AssistantMessageEvent::TextStart {
                            content_index: idx,
                            partial: accumulated.clone(),
                        });
                        let _ = sender.push(AssistantMessageEvent::TextDelta {
                            content_index: idx,
                            delta: text.clone(),
                            partial: accumulated.clone(),
                        });
                    }
                }
            }
        }

        // Handle tool calls
        if let Some(ref tool_calls) = delta.tool_calls {
            for tc in tool_calls {
                let entry = pending_tool_calls
                    .entry(tc.index)
                    .or_insert_with(ToolCallAccumulator::default);
                if let Some(ref id) = tc.id {
                    entry.id = Some(id.clone());
                }
                if let Some(name) = tc.function.as_ref().and_then(|f| f.name.as_ref()) {
                    entry.name = Some(name.to_string());
                }
                if let Some(args) = tc.function.as_ref().and_then(|f| f.arguments.as_ref()) {
                    entry.args.push_str(args);
                    let content_idx = accumulated.content.len();
                    let _ = sender.push(AssistantMessageEvent::ToolCallDelta {
                        content_index: content_idx,
                        delta: args.to_string(),
                        partial: accumulated.clone(),
                    });
                }
            }
        }

        // Handle finish reason
        if let Some(ref finish_reason) = choice.finish_reason {
            if finish_reason == "tool_calls" || finish_reason == "function_call" {
                // Finalize pending tool calls
                for entry in pending_tool_calls.values_mut() {
                    let tool_call = entry.to_tool_call();
                    let content_idx = accumulated.content.len();
                    let _ = sender.push(AssistantMessageEvent::ToolCallEnd {
                        content_index: content_idx,
                        tool_call: tool_call.clone(),
                        partial: accumulated.clone(),
                    });
                    accumulated
                        .content
                        .push(Content::ToolCall(Box::new(tool_call)));
                }
                pending_tool_calls.clear();

                accumulated.stop_reason = StopReason::ToolUse;
            } else {
                match finish_reason.as_str() {
                    "stop" => accumulated.stop_reason = StopReason::Stop,
                    "length" => accumulated.stop_reason = StopReason::Length,
                    _ => accumulated.stop_reason = StopReason::Stop,
                }
            }
        }
    }

    // Handle usage
    if let Some(ref usage_data) = chunk.usage {
        let cached = usage_data
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .unwrap_or(0);
        let reasoning_tokens = usage_data
            .completion_tokens_details
            .as_ref()
            .map(|d| d.reasoning_tokens)
            .unwrap_or(0);

        accumulated.usage.input = usage_data.prompt_tokens;
        accumulated.usage.output = usage_data.completion_tokens;
        accumulated.usage.cache_read = cached;
        accumulated.usage.total_tokens = usage_data.total_tokens;
        accumulated.usage.reasoning = Some(reasoning_tokens);
        accumulated.usage.calculate_cost(&model.cost);
    }
}

#[derive(Debug, Default)]
struct ToolCallAccumulator {
    id: Option<String>,
    name: Option<String>,
    args: String,
}

impl ToolCallAccumulator {
    fn to_tool_call(&self) -> ToolCall {
        ToolCall {
            content_type: "toolCall".into(),
            id: self.id.clone().unwrap_or_default(),
            name: self.name.clone().unwrap_or_default(),
            arguments: serde_json::from_str(&self.args).unwrap_or(Value::Null),
            thought_signature: None,
        }
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/// Stream a chat completion via the OpenAI Completions API.
///
/// Returns an `AssistantMessageEventStream` that yields events as they
/// arrive from the SSE stream. The final event (`Done` or `Error`)
/// contains the complete `AssistantMessage`.
pub fn stream(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    api_key: Option<&str>,
) -> AssistantMessageEventStream {
    let (stream, sender) = create_event_stream();
    let owned_model = model.clone();
    let owned_context = context.clone();
    let owned_options = options.cloned();
    let owned_api_key = api_key.map(|s| s.to_string());

    tokio::spawn(async move {
        if let Err(e) = stream_openai(&owned_model, &owned_context, owned_options.as_ref(), owned_api_key.as_deref(), &sender).await {
            let msg = AssistantMessage::error(
                owned_model.api,
                owned_model.provider.clone(),
                &owned_model.id,
                e.to_string(),
            );
            let _ = sender.push(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: msg,
            });
        }
    });

    stream
}

/// Stream with simplified options (reasoning level).
pub fn stream_simple(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
    api_key: Option<&str>,
) -> AssistantMessageEventStream {
    let reasoning_effort = options
        .and_then(|o| o.reasoning)
        .and_then(thinking_level_to_reasoning_effort)
        .map(|s| s.to_string());
    let base_opts = options.map(|o| o.base.clone());

    let (stream, sender) = create_event_stream();
    let owned_model = model.clone();
    let owned_context = context.clone();
    let owned_api_key = api_key.map(|s| s.to_string());

    tokio::spawn(async move {
        if let Err(e) = stream_openai_with_reasoning(
            &owned_model,
            &owned_context,
            base_opts.as_ref(),
            reasoning_effort,
            owned_api_key.as_deref(),
            &sender,
            ThinkingFormat::OpenAI,
        )
        .await
        {
            let msg = AssistantMessage::error(
                owned_model.api,
                owned_model.provider.clone(),
                &owned_model.id,
                e.to_string(),
            );
            let _ = sender.push(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: msg,
            });
        }
    });

    stream
}

async fn stream_openai_with_reasoning(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    reasoning_effort: Option<String>,
    api_key: Option<&str>,
    sender: &EventStreamSender,
    thinking_format: ThinkingFormat,
) -> Result<()> {
    let request = build_request(model, context, options, reasoning_effort, thinking_format);

    let client = Client::builder()
        .timeout(Duration::from_secs(
            options.and_then(|o| o.timeout_ms).unwrap_or(600_000) / 1000,
        ))
        .build()?;

    let mut http_request = client
        .post(format!("{}/chat/completions", model.base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json");

    if let Some(key) = api_key {
        http_request = http_request.header("Authorization", format!("Bearer {}", key));
    }
    if let Some(headers) = options.and_then(|o| o.headers.as_ref()) {
        for (k, v) in headers {
            http_request = http_request.header(k, v);
        }
    }

    let response = http_request.json(&request).send().await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(AiError::Api {
            status,
            message: body,
        });
    }

    // Build initial partial message
    let mut accumulated = AssistantMessage {
        role: "assistant".into(),
        content: vec![],
        api: model.api,
        provider: model.provider.clone(),
        model: model.id.clone(),
        response_model: None,
        response_id: None,
        usage: Usage::default(),
        stop_reason: StopReason::Stop,
        error_message: None,
        timestamp: chrono::Utc::now().timestamp_millis(),
    };

    let _ = sender.push(AssistantMessageEvent::Start {
        partial: accumulated.clone(),
    });

    let mut stream_model: Option<String> = None;
    let mut pending_tool_calls: HashMap<u32, ToolCallAccumulator> = HashMap::new();
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = byte_stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                // Process complete SSE lines
                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].to_string();
                    buffer = buffer[line_end + 1..].to_string();
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Some(chunk) = parse_sse_line(&line) {
                        accumulate_events(
                            chunk,
                            model,
                            &mut stream_model,
                            &mut accumulated,
                            &mut pending_tool_calls,
                            sender,
                        );
                    }
                }
            }
            Err(e) => {
                return Err(AiError::Stream(format!("SSE stream error: {}", e)));
            }
        }
    }

    // Set response model
    accumulated.response_model = stream_model;
    accumulated.timestamp = chrono::Utc::now().timestamp_millis();

    // Finalize any dangling text/thinking blocks
    for (idx, content) in accumulated.content.iter().enumerate() {
        match content {
            Content::Text(tc) => {
                let _ = sender.push(AssistantMessageEvent::TextEnd {
                    content_index: idx,
                    content: tc.text.clone(),
                    partial: accumulated.clone(),
                });
            }
            Content::Thinking(tc) => {
                let _ = sender.push(AssistantMessageEvent::ThinkingEnd {
                    content_index: idx,
                    content: tc.thinking.clone(),
                    partial: accumulated.clone(),
                });
            }
            _ => {}
        }
    }

    let reason = accumulated.stop_reason;
    if reason == StopReason::Error || reason == StopReason::Aborted {
        let _ = sender.push(AssistantMessageEvent::Error {
            reason,
            error: accumulated,
        });
    } else {
        let _ = sender.push(AssistantMessageEvent::Done {
            reason,
            message: accumulated,
        });
    }

    Ok(())
}

async fn stream_openai(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    api_key: Option<&str>,
    sender: &EventStreamSender,
) -> Result<()> {
    stream_openai_with_reasoning(model, context, options, None, api_key, sender, ThinkingFormat::OpenAI).await
}

/// Stream with explicit thinking format (for providers like DeepSeek).
pub fn stream_with_format(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    api_key: Option<&str>,
    thinking_format: ThinkingFormat,
) -> AssistantMessageEventStream {
    let (stream, sender) = create_event_stream();
    let owned_model = model.clone();
    let owned_context = context.clone();
    let owned_options = options.cloned();
    let owned_api_key = api_key.map(|s| s.to_string());

    tokio::spawn(async move {
        if let Err(e) = stream_openai_with_reasoning(
            &owned_model,
            &owned_context,
            owned_options.as_ref(),
            None,
            owned_api_key.as_deref(),
            &sender,
            thinking_format,
        )
        .await
        {
            let msg = AssistantMessage::error(
                owned_model.api,
                owned_model.provider.clone(),
                &owned_model.id,
                e.to_string(),
            );
            let _ = sender.push(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: msg,
            });
        }
    });

    stream
}

/// Stream with simplified options and explicit thinking format.
pub fn stream_simple_with_format(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
    api_key: Option<&str>,
    thinking_format: ThinkingFormat,
) -> AssistantMessageEventStream {
    let reasoning_effort = options
        .and_then(|o| o.reasoning)
        .and_then(thinking_level_to_reasoning_effort)
        .map(|s| s.to_string());
    let base_opts = options.map(|o| o.base.clone());

    let (stream, sender) = create_event_stream();
    let owned_model = model.clone();
    let owned_context = context.clone();
    let owned_api_key = api_key.map(|s| s.to_string());

    tokio::spawn(async move {
        if let Err(e) = stream_openai_with_reasoning(
            &owned_model,
            &owned_context,
            base_opts.as_ref(),
            reasoning_effort,
            owned_api_key.as_deref(),
            &sender,
            thinking_format,
        )
        .await
        {
            let msg = AssistantMessage::error(
                owned_model.api,
                owned_model.provider.clone(),
                &owned_model.id,
                e.to_string(),
            );
            let _ = sender.push(AssistantMessageEvent::Error {
                reason: StopReason::Error,
                error: msg,
            });
        }
    });

    stream
}
