//! Anthropic Messages API implementation.
//!
//! Handles the Anthropic Messages protocol (POST /v1/messages with SSE streaming).
//! Content-block-based streaming with text, thinking, and tool_use blocks.

use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AiError, Result};
use crate::event_stream::{create_event_stream, AssistantMessageEventStream, EventStreamSender};
use crate::types::*;

// ─── Anthropic Request Types ───────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<AnthropicSystem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<AnthropicTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<AnthropicThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<AnthropicMetadata>,
    stream: bool,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicSystem {
    Text(String),
    Blocks(Vec<AnthropicSystemBlock>),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum AnthropicSystemBlock {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
}

#[derive(Debug, Serialize)]
struct CacheControl {
    #[serde(rename = "type")]
    cache_type: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "role")]
enum AnthropicMessage {
    #[serde(rename = "user")]
    User { content: Vec<AnthropicContent> },
    #[serde(rename = "assistant")]
    Assistant { content: Vec<AnthropicContent> },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum AnthropicContent {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    #[serde(rename = "image")]
    Image {
        source: AnthropicImageSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_control: Option<CacheControl>,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: Vec<AnthropicToolResultContent>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        signature: String,
    },
}

#[derive(Debug, Serialize)]
struct AnthropicImageSource {
    #[serde(rename = "type")]
    source_type: String,
    media_type: String,
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicToolResultContent {
    Text { text: String },
    Image { source: AnthropicImageSource },
}

#[derive(Debug, Serialize)]
struct AnthropicTool {
    name: String,
    description: String,
    input_schema: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_control: Option<CacheControl>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnthropicThinking {
    Budget {
        #[serde(rename = "type")]
        thinking_type: String,
        budget_tokens: u64,
    },
    Adaptive {
        #[serde(rename = "type")]
        thinking_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct AnthropicMetadata {
    user_id: Option<String>,
}

// ─── Anthropic SSE Event Types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: AnthropicMessageData },
    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        content_block: AnthropicContentBlock,
    },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta {
        index: usize,
        delta: AnthropicDelta,
    },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },
    #[serde(rename = "message_delta")]
    MessageDelta {
        delta: AnthropicMessageDelta,
        usage: Option<AnthropicUsage>,
    },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageData {
    id: String,
    model: String,
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens_details: Option<AnthropicOutputDetails>,
}

#[derive(Debug, Deserialize)]
struct AnthropicOutputDetails {
    #[serde(default)]
    thinking_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String, signature: String },
    #[serde(rename = "redacted_thinking")]
    RedactedThinking { data: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicDelta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { thinking: String },
    #[serde(rename = "signature_delta")]
    SignatureDelta { signature: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageDelta {
    stop_reason: Option<String>,
    stop_sequence: Option<String>,
}

// ─── Streaming state ───────────────────────────────────────────────────────────

/// Per-block accumulator for text or tool-use content during streaming.
#[derive(Debug, Default)]
struct ContentBlockAccumulator {
    block_type: String, // "text", "thinking", "tool_use"
    text: String,
    thinking: String,
    signature: String,
    tool_id: Option<String>,
    tool_name: Option<String>,
    tool_args: String,
    redacted: bool,
}

// ─── Context → Anthropic Request Conversion ────────────────────────────────────

fn convert_message(msg: &Message) -> Vec<AnthropicMessage> {
    match msg {
        Message::User(user) => {
            let content = match &user.content {
                UserMessageContent::Text(t) => vec![AnthropicContent::Text {
                    text: t.clone(),
                    cache_control: None,
                }],
                UserMessageContent::Array(parts) => parts
                    .iter()
                    .map(|c| match c {
                        Content::Text(tc) => AnthropicContent::Text {
                            text: tc.text.clone(),
                            cache_control: None,
                        },
                        Content::Image(img) => AnthropicContent::Image {
                            source: AnthropicImageSource {
                                source_type: "base64".into(),
                                media_type: img.mime_type.clone(),
                                data: img.data.clone(),
                            },
                            cache_control: None,
                        },
                        _ => AnthropicContent::Text {
                            text: "[unsupported]".into(),
                            cache_control: None,
                        },
                    })
                    .collect(),
            };
            vec![AnthropicMessage::User { content }]
        }
        Message::Assistant(assistant) => {
            let content: Vec<AnthropicContent> = assistant
                .content
                .iter()
                .map(|c| match c {
                    Content::Text(tc) => AnthropicContent::Text {
                        text: tc.text.clone(),
                        cache_control: None,
                    },
                    Content::Thinking(tc) => AnthropicContent::Thinking {
                        thinking: tc.thinking.clone(),
                        signature: tc
                            .thinking_signature
                            .clone()
                            .unwrap_or_default(),
                    },
                    Content::ToolCall(tc) => AnthropicContent::ToolUse {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        input: tc.arguments.clone(),
                    },
                    _ => AnthropicContent::Text {
                        text: String::new(),
                        cache_control: None,
                    },
                })
                .collect();
            vec![AnthropicMessage::Assistant { content }]
        }
        Message::ToolResult(tr) => {
            let content: Vec<AnthropicToolResultContent> = tr
                .content
                .iter()
                .filter_map(|c| match c {
                    Content::Text(tc) => Some(AnthropicToolResultContent::Text {
                        text: tc.text.clone(),
                    }),
                    Content::Image(img) => Some(AnthropicToolResultContent::Image {
                        source: AnthropicImageSource {
                            source_type: "base64".into(),
                            media_type: img.mime_type.clone(),
                            data: img.data.clone(),
                        },
                    }),
                    _ => None,
                })
                .collect();

            vec![AnthropicMessage::User {
                content: vec![AnthropicContent::ToolResult {
                    tool_use_id: tr.tool_call_id.clone(),
                    content,
                    is_error: if tr.is_error { Some(true) } else { None },
                }],
            }]
        }
    }
}

fn convert_tools(tools: &[Tool]) -> Vec<AnthropicTool> {
    tools
        .iter()
        .map(|t| AnthropicTool {
            name: t.name.clone(),
            description: t.description.clone(),
            input_schema: t.parameters.clone(),
            cache_control: None,
        })
        .collect()
}

fn thinking_level_to_budget(level: ThinkingLevel) -> Option<u64> {
    match level {
        ThinkingLevel::Off => None,
        ThinkingLevel::Minimal => Some(1024),
        ThinkingLevel::Low => Some(4096),
        ThinkingLevel::Medium => Some(8192),
        ThinkingLevel::High => Some(16384),
        ThinkingLevel::XHigh => Some(32768),
    }
}

fn build_request<'a>(
    model: &'a Model,
    context: &'a Context,
    options: Option<&'a StreamOptions>,
    reasoning_level: Option<ThinkingLevel>,
) -> AnthropicRequest<'a> {
    let mut messages: Vec<AnthropicMessage> = Vec::new();

    for msg in &context.messages {
        messages.extend(convert_message(msg));
    }

    let system = context
        .system_prompt
        .as_ref()
        .map(|sp| AnthropicSystem::Text(sp.clone()));

    let tools = if context.tools.is_empty() {
        None
    } else {
        Some(convert_tools(&context.tools))
    };

    let max_tokens = options
        .and_then(|o| o.max_tokens)
        .unwrap_or(model.max_tokens);

    let temperature = options.and_then(|o| o.temperature);

    // Build thinking config based on model + reasoning level
    let thinking = reasoning_level.and_then(|lvl| {
        if lvl == ThinkingLevel::Off {
            return None;
        }
        // Check if model uses adaptive thinking (Opus 4.7+, Fable 5)
        let is_adaptive = model.id.contains("claude-opus-4")
            || model.id.contains("claude-fable-5")
            || model.id.contains("claude-sonnet-5");

        if is_adaptive {
            Some(AnthropicThinking::Adaptive {
                thinking_type: "adaptive".into(),
                effort: Some(lvl.as_str().to_string()),
            })
        } else {
            let budget = thinking_level_to_budget(lvl)?;
            Some(AnthropicThinking::Budget {
                thinking_type: "enabled".into(),
                budget_tokens: budget,
            })
        }
    });

    AnthropicRequest {
        model: &model.id,
        messages,
        system,
        tools,
        max_tokens: Some(max_tokens),
        temperature,
        thinking,
        metadata: None,
        stream: true,
    }
}

// ─── SSE Parsing ───────────────────────────────────────────────────────────────

fn parse_anthropic_sse_line(line: &str) -> Option<AnthropicEvent> {
    // Anthropic SSE: "event: <type>\ndata: <json>"
    let parts: Vec<&str> = line.splitn(2, '\n').collect();
    let data_str = if parts.len() == 2 {
        parts[1]
    } else {
        line
    };
    let data_str = data_str.strip_prefix("data: ")?;
    serde_json::from_str(data_str).ok()
}

/// Parse raw SSE bytes stream into individual SSE "event" strings.
fn split_sse_events(buffer: &str) -> (Vec<String>, String) {
    let mut events = Vec::new();
    let mut current = String::new();
    let mut lines = buffer.lines().peekable();

    while let Some(line) = lines.next() {
        if line.is_empty() {
            // Empty line = event boundary in SSE
            if !current.is_empty() {
                events.push(std::mem::take(&mut current));
            }
        } else {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        }
    }

    (events, current)
}

// ─── Public API ────────────────────────────────────────────────────────────────

/// Stream a chat completion via the Anthropic Messages API.
pub fn stream(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    api_key: Option<&str>,
) -> AssistantMessageEventStream {
    stream_inner(model, context, options, None, api_key)
}

/// Stream with simplified options (reasoning level).
pub fn stream_simple(
    model: &Model,
    context: &Context,
    options: Option<&SimpleStreamOptions>,
    api_key: Option<&str>,
) -> AssistantMessageEventStream {
    let reasoning = options.and_then(|o| o.reasoning);
    let base_opts = options.map(|o| o.base.clone());
    stream_inner(model, context, base_opts.as_ref(), reasoning, api_key)
}

fn stream_inner(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    reasoning_level: Option<ThinkingLevel>,
    api_key: Option<&str>,
) -> AssistantMessageEventStream {
    let (stream, sender) = create_event_stream();
    let owned_model = model.clone();
    let owned_context = context.clone();
    let owned_options = options.cloned();
    let owned_api_key = api_key.map(|s| s.to_string());

    tokio::spawn(async move {
        if let Err(e) = do_stream(
            &owned_model,
            &owned_context,
            owned_options.as_ref(),
            reasoning_level,
            owned_api_key.as_deref(),
            &sender,
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

async fn do_stream(
    model: &Model,
    context: &Context,
    options: Option<&StreamOptions>,
    reasoning_level: Option<ThinkingLevel>,
    api_key: Option<&str>,
    sender: &EventStreamSender,
) -> Result<()> {
    let request = build_request(model, context, options, reasoning_level);

    let client = Client::builder()
        .timeout(Duration::from_secs(
            options.and_then(|o| o.timeout_ms).unwrap_or(600_000) / 1000,
        ))
        .build()?;

    let mut http_request = client
        .post(format!(
            "{}/v1/messages",
            model.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .header("anthropic-version", "2023-06-01");

    if let Some(key) = api_key {
        http_request = http_request.header("x-api-key", key);
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

    let mut blocks: Vec<ContentBlockAccumulator> = Vec::new();
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut message_started = false;

    while let Some(chunk_result) = byte_stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                let (events, remaining) = split_sse_events(&buffer);
                buffer = remaining;

                for event_str in events {
                    // Parse SSE event line: "event: <type>\ndata: <json>"
                    let (event_type, data) = if let Some(rest) = event_str.strip_prefix("event: ") {
                        let parts: Vec<&str> = rest.splitn(2, '\n').collect();
                        if parts.len() == 2 {
                            (Some(parts[0].to_string()), parts[1].to_string())
                        } else {
                            (Some(parts[0].to_string()), String::new())
                        }
                    } else if let Some(data) = event_str.strip_prefix("data: ") {
                        (None, data.to_string())
                    } else {
                        continue;
                    };

                    let data = data.strip_prefix("data: ").unwrap_or(&data);
                    let event: AnthropicEvent = match serde_json::from_str(data) {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    match event {
                        AnthropicEvent::MessageStart { message } => {
                            accumulated.response_id = Some(message.id);
                            accumulated.response_model = Some(message.model);
                            if let Some(usage) = message.usage {
                                apply_usage(&mut accumulated.usage, &usage, model);
                            }
                            if !message_started {
                                let _ = sender.push(AssistantMessageEvent::Start {
                                    partial: accumulated.clone(),
                                });
                                message_started = true;
                            }
                        }
                        AnthropicEvent::ContentBlockStart {
                            index,
                            content_block,
                        } => {
                            // Ensure blocks vector is large enough
                            while blocks.len() <= index {
                                blocks.push(ContentBlockAccumulator::default());
                            }
                            let block = &mut blocks[index];

                            match content_block {
                                AnthropicContentBlock::Text { text } => {
                                    block.block_type = "text".into();
                                    block.text = text.clone();
                                    let content_idx = accumulated.content.len();
                                    accumulated
                                        .content
                                        .push(Content::Text(TextContent {
                                            content_type: "text".into(),
                                            text,
                                            text_signature: None,
                                        }));
                                    let _ = sender.push(AssistantMessageEvent::TextStart {
                                        content_index: content_idx,
                                        partial: accumulated.clone(),
                                    });
                                }
                                AnthropicContentBlock::Thinking {
                                    thinking,
                                    signature,
                                } => {
                                    block.block_type = "thinking".into();
                                    block.thinking = thinking.clone();
                                    block.signature = signature.clone();
                                    let content_idx = accumulated.content.len();
                                    accumulated
                                        .content
                                        .push(Content::Thinking(ThinkingContent {
                                            content_type: "thinking".into(),
                                            thinking,
                                            thinking_signature: Some(signature),
                                            redacted: false,
                                        }));
                                    let _ =
                                        sender.push(AssistantMessageEvent::ThinkingStart {
                                            content_index: content_idx,
                                            partial: accumulated.clone(),
                                        });
                                }
                                AnthropicContentBlock::RedactedThinking { .. } => {
                                    block.block_type = "thinking".into();
                                    block.redacted = true;
                                    let content_idx = accumulated.content.len();
                                    accumulated
                                        .content
                                        .push(Content::Thinking(ThinkingContent {
                                            content_type: "thinking".into(),
                                            thinking: "[redacted]".into(),
                                            thinking_signature: Some(String::new()),
                                            redacted: true,
                                        }));
                                    let _ =
                                        sender.push(AssistantMessageEvent::ThinkingStart {
                                            content_index: content_idx,
                                            partial: accumulated.clone(),
                                        });
                                }
                                AnthropicContentBlock::ToolUse { id, name, .. } => {
                                    block.block_type = "tool_use".into();
                                    block.tool_id = Some(id.clone());
                                    block.tool_name = Some(name.clone());
                                    let content_idx = accumulated.content.len();
                                    let _ =
                                        sender.push(AssistantMessageEvent::ToolCallStart {
                                            content_index: content_idx,
                                            partial: accumulated.clone(),
                                        });
                                }
                            }
                        }
                        AnthropicEvent::ContentBlockDelta { index, delta } => {
                            while blocks.len() <= index {
                                blocks.push(ContentBlockAccumulator::default());
                            }
                            let block = &mut blocks[index];

                            match delta {
                                AnthropicDelta::TextDelta { text } => {
                                    block.text.push_str(&text);
                                    if let Some(Content::Text(ref mut tc)) =
                                        accumulated.content.get_mut(index)
                                    {
                                        tc.text.push_str(&text);
                                    }
                                    let _ = sender.push(AssistantMessageEvent::TextDelta {
                                        content_index: index,
                                        delta: text,
                                        partial: accumulated.clone(),
                                    });
                                }
                                AnthropicDelta::ThinkingDelta { thinking } => {
                                    block.thinking.push_str(&thinking);
                                    if let Some(Content::Thinking(ref mut tc)) =
                                        accumulated.content.get_mut(index)
                                    {
                                        tc.thinking.push_str(&thinking);
                                    }
                                    let _ =
                                        sender.push(AssistantMessageEvent::ThinkingDelta {
                                            content_index: index,
                                            delta: thinking,
                                            partial: accumulated.clone(),
                                        });
                                }
                                AnthropicDelta::SignatureDelta { signature } => {
                                    block.signature.push_str(&signature);
                                    if let Some(Content::Thinking(ref mut tc)) =
                                        accumulated.content.get_mut(index)
                                    {
                                        let sig = tc.thinking_signature.get_or_insert_default();
                                        sig.push_str(&signature);
                                    }
                                }
                                AnthropicDelta::InputJsonDelta { partial_json } => {
                                    block.tool_args.push_str(&partial_json);
                                    let _ =
                                        sender.push(AssistantMessageEvent::ToolCallDelta {
                                            content_index: index,
                                            delta: partial_json,
                                            partial: accumulated.clone(),
                                        });
                                }
                            }
                        }
                        AnthropicEvent::ContentBlockStop { index } => {
                            while blocks.len() <= index {
                                blocks.push(ContentBlockAccumulator::default());
                            }
                            let block = &blocks[index];

                            match block.block_type.as_str() {
                                "text" => {
                                    let _ = sender.push(AssistantMessageEvent::TextEnd {
                                        content_index: index,
                                        content: block.text.clone(),
                                        partial: accumulated.clone(),
                                    });
                                }
                                "thinking" => {
                                    let _ =
                                        sender.push(AssistantMessageEvent::ThinkingEnd {
                                            content_index: index,
                                            content: block.thinking.clone(),
                                            partial: accumulated.clone(),
                                        });
                                }
                                "tool_use" => {
                                    let tool_call = ToolCall {
                                        content_type: "toolCall".into(),
                                        id: block.tool_id.clone().unwrap_or_default(),
                                        name: block.tool_name.clone().unwrap_or_default(),
                                        arguments: serde_json::from_str(&block.tool_args)
                                            .unwrap_or(Value::Null),
                                        thought_signature: None,
                                    };
                                    // Replace placeholder at index with the actual tool call
                                    if index < accumulated.content.len() {
                                        accumulated.content[index] =
                                            Content::ToolCall(Box::new(tool_call.clone()));
                                    } else {
                                        accumulated
                                            .content
                                            .push(Content::ToolCall(Box::new(tool_call.clone())));
                                    }
                                    let _ =
                                        sender.push(AssistantMessageEvent::ToolCallEnd {
                                            content_index: index,
                                            tool_call,
                                            partial: accumulated.clone(),
                                        });
                                }
                                _ => {}
                            }
                        }
                        AnthropicEvent::MessageDelta {
                            delta,
                            usage,
                        } => {
                            if let Some(ref stop_reason) = delta.stop_reason {
                                accumulated.stop_reason = match stop_reason.as_str() {
                                    "end_turn" => StopReason::Stop,
                                    "max_tokens" => StopReason::Length,
                                    "tool_use" => StopReason::ToolUse,
                                    _ => StopReason::Stop,
                                };
                            }
                            if let Some(usage) = usage {
                                apply_usage(&mut accumulated.usage, &usage, model);
                            }
                        }
                        AnthropicEvent::MessageStop => {
                            accumulated.timestamp = chrono::Utc::now().timestamp_millis();
                            let reason = accumulated.stop_reason;
                            let _ = sender.push(AssistantMessageEvent::Done {
                                reason,
                                message: accumulated.clone(),
                            });
                            return Ok(());
                        }
                        AnthropicEvent::Ping => {
                            // No-op
                        }
                    }
                }
            }
            Err(e) => {
                return Err(AiError::Stream(format!("SSE stream error: {}", e)));
            }
        }
    }

    // If we get here without MessageStop, treat as error
    accumulated.stop_reason = StopReason::Error;
    accumulated.error_message = Some("Stream ended without message_stop event".into());
    let _ = sender.push(AssistantMessageEvent::Error {
        reason: StopReason::Error,
        error: accumulated,
    });

    Ok(())
}

fn apply_usage(usage: &mut Usage, anthropic_usage: &AnthropicUsage, model: &Model) {
    usage.input = anthropic_usage.input_tokens.unwrap_or(0);
    usage.output = anthropic_usage.output_tokens.unwrap_or(0);
    usage.cache_read = anthropic_usage.cache_read_input_tokens.unwrap_or(0);
    usage.cache_write = anthropic_usage.cache_creation_input_tokens.unwrap_or(0);
    usage.total_tokens = usage.input + usage.output;
    if let Some(ref details) = anthropic_usage.output_tokens_details {
        usage.reasoning = details.thinking_tokens;
    }
    usage.calculate_cost(&model.cost);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_anthropic_event() {
        let json = r#"{"type": "message_start", "message": {"id": "msg_123", "model": "claude-sonnet-5", "usage": {"input_tokens": 100, "output_tokens": 50}}}"#;
        let event: AnthropicEvent = serde_json::from_str(json).unwrap();
        match event {
            AnthropicEvent::MessageStart { message } => {
                assert_eq!(message.id, "msg_123");
                assert_eq!(message.model, "claude-sonnet-5");
            }
            _ => panic!("expected MessageStart"),
        }
    }

    #[test]
    fn test_parse_content_block() {
        let json = r#"{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "Hello"}}"#;
        let event: AnthropicEvent = serde_json::from_str(json).unwrap();
        match event {
            AnthropicEvent::ContentBlockStart {
                index,
                content_block,
            } => {
                assert_eq!(index, 0);
                match content_block {
                    AnthropicContentBlock::Text { text } => assert_eq!(text, "Hello"),
                    _ => panic!("expected Text"),
                }
            }
            _ => panic!("expected ContentBlockStart"),
        }
    }

    #[test]
    fn test_split_sse_events() {
        let input = "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let (events, remaining) = split_sse_events(input);
        assert_eq!(events.len(), 2);
        assert!(events[0].contains("message_start"));
        assert!(events[1].contains("message_stop"));
        assert!(remaining.is_empty());
    }
}
