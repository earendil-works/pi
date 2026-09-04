// This adapter intentionally remains one module slightly above 1,000 lines: request
// serialization and incremental response reduction share the same provider/API
// dispatch table. Keeping that table local makes request/response protocol pairs
// auditable and prevents compatibility changes from drifting between modules.
use std::collections::HashMap;

use async_stream::stream;
use futures::StreamExt;
use reqwest::{Client, Response};
use serde_json::{Value, json};

use crate::{
    AiError, AssistantMessage, AssistantMessageEvent as Event, Content, Context, EventStream, Message, Model,
    ResolvedAuth, StopReason, StreamOptions, UserContent,
};

pub async fn stream_http(
    client: Client,
    mut model: Model,
    context: Context,
    mut options: StreamOptions,
    auth: ResolvedAuth,
) -> Result<EventStream, AiError> {
    if options.api_key.is_none() {
        options.api_key.clone_from(&auth.api_key);
    }
    resolve_endpoint_configuration(&mut model, &options);
    let (url, payload) = build_request(&model, &context, &options, auth.base_url.as_deref())?;
    let mut request = client.post(url).json(&payload);
    if let Some(timeout) = options.timeout_ms {
        request = request.timeout(std::time::Duration::from_millis(timeout));
    }
    for (name, value) in &model.headers {
        request = request.header(name, value);
    }
    for (name, value) in auth.headers {
        request = request.header(name, value);
    }
    for (name, value) in &options.headers {
        if let Some(value) = value {
            request = request.header(name, value);
        }
    }
    if let Some(api_key) = auth.api_key {
        let anthropic_oauth = model.api == "anthropic-messages"
            && auth
                .source
                .as_deref()
                .is_some_and(|source| source == "OAuth" || source == "ANTHROPIC_OAUTH_TOKEN");
        request = if anthropic_oauth {
            request
                .bearer_auth(api_key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "oauth-2025-04-20")
        } else if model.api == "anthropic-messages" {
            request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        } else if model.api == "azure-openai-responses" {
            request.header("api-key", api_key)
        } else if model.api == "google-generative-ai" || model.api == "google-vertex" {
            request
        } else {
            request.bearer_auth(api_key)
        };
    }
    request = request
        .header("accept", "text/event-stream")
        .header("user-agent", crate::user_agent());
    let response = if let Some(cancellation) = &options.cancellation {
        tokio::select! {
            response = request.send() => match response {
                Ok(response) => response,
                Err(error) => return Ok(crate::failed_stream(&model, error.to_string(), StopReason::Error)),
            },
            () = cancellation.cancelled() => {
                return Ok(crate::failed_stream(&model, "request aborted", StopReason::Aborted));
            }
        }
    } else {
        match request.send().await {
            Ok(response) => response,
            Err(error) => return Ok(crate::failed_stream(&model, error.to_string(), StopReason::Error)),
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Ok(crate::failed_stream(
            &model,
            format!("HTTP {}: {body}", status.as_u16()),
            StopReason::Error,
        ));
    }
    Ok(parse_response(response, model, options.cancellation))
}

fn env_value(options: &StreamOptions, name: &str) -> Option<String> {
    options
        .env
        .get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

fn resolve_endpoint_configuration(model: &mut Model, options: &StreamOptions) {
    if model.provider == "azure-openai-responses" {
        if let Some(base) = env_value(options, "AZURE_OPENAI_BASE_URL") {
            model.base_url = base;
        } else if let Some(resource) = env_value(options, "AZURE_OPENAI_RESOURCE_NAME") {
            model.base_url = format!("https://{resource}.openai.azure.com/openai/v1");
        }
        let trimmed = model.base_url.trim_end_matches('/');
        if !trimmed.contains("/openai/") {
            model.base_url = format!("{trimmed}/openai/v1");
        }
    }
    if model.provider == "cloudflare-workers-ai"
        && let Some(account) = env_value(options, "CLOUDFLARE_ACCOUNT_ID")
    {
        model.base_url = model.base_url.replace("{account}", &account);
    }
    if model.provider == "cloudflare-ai-gateway" {
        if let Some(account) = env_value(options, "CLOUDFLARE_ACCOUNT_ID") {
            model.base_url = model.base_url.replace("{account}", &account);
        }
        if let Some(gateway) = env_value(options, "CLOUDFLARE_GATEWAY_ID") {
            model.base_url = model.base_url.replace("{gateway}", &gateway);
        }
    }
}

fn endpoint(model: &Model, base_url: Option<&str>) -> String {
    let base = base_url.unwrap_or(&model.base_url).trim_end_matches('/');
    match model.api.as_str() {
        "openai-completions" | "mistral-conversations" => format!("{base}/chat/completions"),
        "openai-responses" | "openai-codex-responses" | "azure-openai-responses" => format!("{base}/responses"),
        "anthropic-messages" => format!("{base}/messages"),
        "google-generative-ai" | "google-vertex" => format!("{base}/models/{}:streamGenerateContent?alt=sse", model.id),
        "pi-messages" => format!("{base}/messages"),
        _ => format!("{base}/chat/completions"),
    }
}

fn build_request(
    model: &Model,
    context: &Context,
    options: &StreamOptions,
    base_url: Option<&str>,
) -> Result<(String, Value), AiError> {
    let mut url = endpoint(model, base_url);
    if matches!(model.api.as_str(), "google-generative-ai" | "google-vertex")
        && let Some(key) = &options.api_key
    {
        url.push_str("&key=");
        url.extend(url::form_urlencoded::byte_serialize(key.as_bytes()));
    }
    let payload = match model.api.as_str() {
        "anthropic-messages" => anthropic_payload(model, context, options),
        "mistral-conversations" => mistral_payload(model, context, options),
        "google-generative-ai" | "google-vertex" => google_payload(model, context, options),
        "openai-responses" | "openai-codex-responses" | "azure-openai-responses" => {
            openai_responses_payload(model, context, options)
        }
        _ => openai_chat_payload(model, context, options),
    };
    Ok((url, payload))
}

fn openai_chat_payload(model: &Model, context: &Context, options: &StreamOptions) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = &context.system_prompt {
        messages.push(json!({"role": "system", "content": system}));
    }
    for message in &context.messages {
        match message {
            Message::User { content, .. } => {
                messages.push(json!({"role":"user", "content": openai_user_content(content)}))
            }
            Message::Assistant { message } => {
                let text = assistant_text_for(model, message);
                let calls = message
                    .content
                    .iter()
                    .filter_map(|content| match content {
                        Content::ToolCall {
                            id, name, arguments, ..
                        } => Some(json!({
                            "id": id, "type":"function", "function":{"name":name, "arguments":arguments.to_string()}
                        })),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let mut value = json!({"role":"assistant", "content": text});
                if message.provider == model.provider {
                    let reasoning = message
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            Content::Thinking {
                                thinking,
                                redacted: false,
                                ..
                            } => Some(thinking.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !reasoning.is_empty() {
                        value["reasoning_content"] = json!(reasoning);
                    }
                }
                if !calls.is_empty() {
                    value["tool_calls"] = Value::Array(calls);
                }
                messages.push(value);
            }
            Message::ToolResult {
                tool_call_id, content, ..
            } => messages.push(json!({
                "role":"tool", "tool_call_id":tool_call_id, "content":content_text(content)
            })),
        }
    }
    let tools = context.tools.iter().map(openai_chat_tool).collect::<Vec<_>>();
    let mut payload = json!({
        "model":model.id, "messages":messages, "stream":true,
        "stream_options":{"include_usage":true}, "max_completion_tokens":options.max_tokens.unwrap_or(model.max_tokens)
    });
    if !tools.is_empty() {
        payload["tools"] = Value::Array(tools);
    }
    if let Some(temperature) = options.temperature {
        payload["temperature"] = json!(temperature);
    }
    if options.reasoning != crate::ThinkingLevel::Off {
        payload["reasoning_effort"] = json!(format!("{:?}", options.reasoning).to_lowercase());
    }
    for (key, value) in model.sampling_params.iter().chain(options.sampling_params.iter()) {
        payload[key] = value.clone();
    }
    payload
}

fn mistral_payload(model: &Model, context: &Context, options: &StreamOptions) -> Value {
    let mut payload = openai_chat_payload(model, context, options);
    if let Some(value) = payload
        .as_object_mut()
        .and_then(|object| object.remove("max_completion_tokens"))
    {
        payload["max_tokens"] = value;
    }
    payload.as_object_mut().map(|object| object.remove("stream_options"));
    payload
}

fn openai_responses_payload(model: &Model, context: &Context, options: &StreamOptions) -> Value {
    let mut input = Vec::new();
    for message in &context.messages {
        match message {
            Message::User { content, .. } => input.push(json!({"role":"user", "content":openai_user_content(content)})),
            Message::Assistant { message } => {
                let text = assistant_text_for(model, message);
                if !text.is_empty() {
                    input.push(json!({"role":"assistant", "content":text}));
                }
                for content in &message.content {
                    if let Content::ToolCall {
                        id, name, arguments, ..
                    } = content
                    {
                        input.push(
                            json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments.to_string()}),
                        );
                    }
                }
            }
            Message::ToolResult {
                tool_call_id, content, ..
            } => input.push(json!({
                "type":"function_call_output", "call_id":tool_call_id, "output":content_text(content)
            })),
        }
    }
    let tools = context.tools.iter().map(openai_responses_tool).collect::<Vec<_>>();
    let mut payload = json!({
        "model":model.id, "input":input, "stream":true, "max_output_tokens":options.max_tokens.unwrap_or(model.max_tokens)
    });
    if let Some(system) = &context.system_prompt {
        payload["instructions"] = json!(system);
    }
    if !tools.is_empty() {
        payload["tools"] = Value::Array(tools);
    }
    if options.reasoning != crate::ThinkingLevel::Off {
        payload["reasoning"] = json!({"effort":format!("{:?}", options.reasoning).to_lowercase(),"summary":"auto"});
    }
    payload
}

fn anthropic_payload(model: &Model, context: &Context, options: &StreamOptions) -> Value {
    let mut messages = Vec::new();
    for message in &context.messages {
        match message {
            Message::User { content, .. } => {
                messages.push(json!({"role":"user", "content":anthropic_content(content)}))
            }
            Message::Assistant { message } => messages.push(
                json!({"role":"assistant", "content":message.content.iter().map(|block| anthropic_replay_block(model, message, block)).collect::<Vec<_>>()}),
            ),
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => messages.push(json!({"role":"user", "content":[{
                "type":"tool_result", "tool_use_id":tool_call_id, "content":content_text(content), "is_error":is_error
            }]})),
        }
    }
    let tools = context.tools.iter().map(anthropic_tool).collect::<Vec<_>>();
    let mut payload = json!({"model":model.id,"messages":messages,"stream":true,"max_tokens":options.max_tokens.unwrap_or(model.max_tokens)});
    if let Some(system) = &context.system_prompt {
        payload["system"] = json!(system);
    }
    if !tools.is_empty() {
        payload["tools"] = Value::Array(tools);
    }
    if options.reasoning != crate::ThinkingLevel::Off {
        let budget = options
            .thinking_budgets
            .get(&format!("{:?}", options.reasoning).to_lowercase())
            .copied()
            .unwrap_or(2048);
        payload["thinking"] = json!({"type":"enabled","budget_tokens":budget});
    }
    payload
}

fn google_payload(model: &Model, context: &Context, options: &StreamOptions) -> Value {
    let contents = context
        .messages
        .iter()
        .map(|message| match message {
            Message::User { content, .. } => json!({"role":"user","parts":google_parts(content)}),
            Message::Assistant { message } => json!({"role":"model","parts":message.content.iter().map(|block| google_replay_block(model, message, block)).collect::<Vec<_>>()}) ,
            Message::ToolResult { tool_name, content, .. } => json!({"role":"user","parts":[{"functionResponse":{"name":tool_name,"response":{"result":content_text(content)}}}]}),
        })
        .collect::<Vec<_>>();
    let declarations = context
        .tools
        .iter()
        .map(|tool| json!({"name":tool.name,"description":tool.description,"parameters":tool.parameters}))
        .collect::<Vec<_>>();
    let mut payload = json!({"contents":contents,"generationConfig":{"maxOutputTokens":options.max_tokens}});
    if let Some(system) = &context.system_prompt {
        payload["systemInstruction"] = json!({"parts":[{"text":system}]});
    }
    if !declarations.is_empty() {
        payload["tools"] = json!([{"functionDeclarations":declarations}]);
    }
    payload
}

fn strict_tool(tool: &crate::Tool) -> bool {
    matches!(
        tool.constrained_sampling,
        Some(crate::ConstrainedSampling::JsonSchema { .. })
    )
}

fn openai_chat_tool(tool: &crate::Tool) -> Value {
    json!({"type":"function", "function":{"name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":strict_tool(tool)}})
}

fn openai_responses_tool(tool: &crate::Tool) -> Value {
    json!({"type":"function", "name":tool.name,"description":tool.description,"parameters":tool.parameters,"strict":strict_tool(tool)})
}

fn anthropic_tool(tool: &crate::Tool) -> Value {
    json!({"name":tool.name,"description":tool.description,"input_schema":tool.parameters,"strict":strict_tool(tool)})
}

fn openai_user_content(content: &UserContent) -> Value {
    match content {
        UserContent::Text(text) => json!(text),
        UserContent::Blocks(blocks) => Value::Array(
            blocks
                .iter()
                .filter_map(|block| match block {
                    Content::Text { text, .. } => Some(json!({"type":"text","text":text})),
                    Content::Image { data, mime_type } => {
                        Some(json!({"type":"image_url","image_url":{"url":format!("data:{mime_type};base64,{data}")}}))
                    }
                    _ => None,
                })
                .collect(),
        ),
    }
}

fn anthropic_content(content: &UserContent) -> Value {
    match content {
        UserContent::Text(text) => json!(text),
        UserContent::Blocks(blocks) => Value::Array(blocks.iter().map(anthropic_block).collect()),
    }
}

fn anthropic_block(block: &Content) -> Value {
    match block {
        Content::Text { text, .. } => json!({"type":"text","text":text}),
        Content::Thinking {
            thinking,
            thinking_signature,
            ..
        } => json!({"type":"thinking","thinking":thinking,"signature":thinking_signature}),
        Content::Image { data, mime_type } => {
            json!({"type":"image","source":{"type":"base64","media_type":mime_type,"data":data}})
        }
        Content::ToolCall {
            id, name, arguments, ..
        } => json!({"type":"tool_use","id":id,"name":name,"input":arguments}),
    }
}

fn google_parts(content: &UserContent) -> Vec<Value> {
    match content {
        UserContent::Text(text) => vec![json!({"text":text})],
        UserContent::Blocks(blocks) => blocks.iter().map(google_block).collect(),
    }
}

fn google_block(block: &Content) -> Value {
    match block {
        Content::Text { text, .. } | Content::Thinking { thinking: text, .. } => json!({"text":text}),
        Content::Image { data, mime_type } => json!({"inlineData":{"mimeType":mime_type,"data":data}}),
        Content::ToolCall { name, arguments, .. } => json!({"functionCall":{"name":name,"args":arguments}}),
    }
}

fn assistant_text_for(model: &Model, message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text, .. } => Some(text.clone()),
            Content::Thinking {
                thinking,
                redacted: false,
                ..
            } if message.provider != model.provider || message.api != model.api => {
                Some(format!("<thinking>\n{thinking}\n</thinking>"))
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn anthropic_replay_block(model: &Model, message: &AssistantMessage, block: &Content) -> Value {
    if let Content::Thinking {
        thinking,
        redacted: false,
        ..
    } = block
        && (message.provider != model.provider || message.api != model.api)
    {
        return json!({"type":"text","text":format!("<thinking>\n{thinking}\n</thinking>")});
    }
    anthropic_block(block)
}

fn google_replay_block(model: &Model, message: &AssistantMessage, block: &Content) -> Value {
    if let Content::Thinking {
        thinking,
        redacted: false,
        ..
    } = block
        && (message.provider != model.provider || message.api != model.api)
    {
        return json!({"text":format!("<thinking>\n{thinking}\n</thinking>")});
    }
    google_block(block)
}

fn content_text(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_response(
    response: Response,
    model: Model,
    cancellation: Option<tokio_util::sync::CancellationToken>,
) -> EventStream {
    Box::pin(stream! {
        let mut state = StreamState::new(&model);
        yield Event::Start { partial: state.message.clone() };
        let mut bytes = response.bytes_stream();
        let mut buffer = String::new();
        loop {
            let chunk = if let Some(cancellation) = &cancellation {
                tokio::select! {
                    chunk = bytes.next() => chunk,
                    () = cancellation.cancelled() => {
                        for event in state.finish(StopReason::Aborted, Some("request aborted")) { yield event; }
                        return;
                    }
                }
            } else {
                bytes.next().await
            };
            let Some(chunk) = chunk else { break; };
            match chunk {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    while let Some(position) = buffer.find("\n\n").or_else(|| buffer.find("\r\n\r\n")) {
                        let separator = if buffer[position..].starts_with("\r\n") { 4 } else { 2 };
                        let record = buffer[..position].to_owned();
                        buffer.drain(..position + separator);
                        for event in state.record(&record) {
                            yield event;
                        }
                        if state.terminal {
                            return;
                        }
                    }
                }
                Err(error) => {
                    state.message.stop_reason = StopReason::Error;
                    state.message.error_message = Some(error.to_string());
                    yield Event::Error { reason: StopReason::Error, error: state.message };
                    return;
                }
            }
        }
        if !state.terminal && !buffer.trim().is_empty() {
            for event in state.record(&buffer) { yield event; }
        }
        if !state.terminal {
            for event in state.finish(StopReason::Stop, None) {
                yield event;
            }
        }
    })
}

struct ToolBuffer {
    content_index: usize,
    id: String,
    name: String,
    arguments: String,
}

struct StreamState {
    message: AssistantMessage,
    tools: HashMap<usize, ToolBuffer>,
    terminal: bool,
    cost: crate::ModelCost,
}

impl StreamState {
    fn new(model: &Model) -> Self {
        Self {
            message: AssistantMessage::empty(model),
            tools: HashMap::new(),
            terminal: false,
            cost: model.cost.clone(),
        }
    }

    fn record(&mut self, record: &str) -> Vec<Event> {
        let data = record
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Vec::new();
        }
        if data == "[DONE]" {
            return self.finish(self.message.stop_reason, None);
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            return Vec::new();
        };
        match self.message.api.as_str() {
            "anthropic-messages" => self.anthropic(&value),
            "openai-responses" | "openai-codex-responses" | "azure-openai-responses" => self.responses(&value),
            "google-generative-ai" | "google-vertex" => self.google(&value),
            "mistral-conversations" => self.chat(value.get("data").unwrap_or(&value)),
            _ => self.chat(&value),
        }
    }

    fn text_delta(&mut self, delta: &str, thinking: bool) -> Vec<Event> {
        if delta.is_empty() {
            return Vec::new();
        }
        let matching = self.message.content.last().is_some_and(|block| {
            matches!(
                (block, thinking),
                (Content::Text { .. }, false) | (Content::Thinking { .. }, true)
            )
        });
        let mut events = Vec::new();
        if !matching {
            let index = self.message.content.len();
            self.message.content.push(if thinking {
                Content::thinking("")
            } else {
                Content::text("")
            });
            events.push(if thinking {
                Event::ThinkingStart {
                    content_index: index,
                    partial: self.message.clone(),
                }
            } else {
                Event::TextStart {
                    content_index: index,
                    partial: self.message.clone(),
                }
            });
        }
        let index = self.message.content.len() - 1;
        match &mut self.message.content[index] {
            Content::Text { text, .. } => text.push_str(delta),
            Content::Thinking { thinking, .. } => thinking.push_str(delta),
            _ => unreachable!(),
        }
        events.push(if thinking {
            Event::ThinkingDelta {
                content_index: index,
                delta: delta.to_owned(),
                partial: self.message.clone(),
            }
        } else {
            Event::TextDelta {
                content_index: index,
                delta: delta.to_owned(),
                partial: self.message.clone(),
            }
        });
        events
    }

    fn tool_delta(
        &mut self,
        upstream_index: usize,
        id: Option<&str>,
        name: Option<&str>,
        arguments: &str,
    ) -> Vec<Event> {
        let mut events = Vec::new();
        let is_new = !self.tools.contains_key(&upstream_index);
        let buffer = self.tools.entry(upstream_index).or_insert_with(|| {
            let content_index = self.message.content.len();
            self.message
                .content
                .push(Content::tool_call(id.unwrap_or_else(|| "call_pending"), "", json!({})));
            ToolBuffer {
                content_index,
                id: id.unwrap_or_else(|| "call_pending").to_owned(),
                name: String::new(),
                arguments: String::new(),
            }
        });
        if let Some(id) = id {
            buffer.id = id.to_owned();
        }
        if let Some(name) = name {
            buffer.name.push_str(name);
        }
        buffer.arguments.push_str(arguments);
        let parsed = parse_partial_json(&buffer.arguments);
        self.message.content[buffer.content_index] = Content::tool_call(&buffer.id, &buffer.name, parsed);
        if is_new {
            events.push(Event::ToolcallStart {
                content_index: buffer.content_index,
                partial: self.message.clone(),
            });
        }
        if !arguments.is_empty() {
            events.push(Event::ToolcallDelta {
                content_index: buffer.content_index,
                delta: arguments.to_owned(),
                partial: self.message.clone(),
            });
        }
        events
    }

    fn chat(&mut self, value: &Value) -> Vec<Event> {
        let mut events = Vec::new();
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            self.message.response_model = Some(model.to_owned());
        }
        if let Some(usage) = value.get("usage") {
            self.read_openai_usage(usage);
        }
        let Some(choice) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return events;
        };
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            events.extend(self.text_delta(text, false));
        } else if let Some(blocks) = delta.get("content").and_then(Value::as_array) {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("thinking") {
                    if let Some(parts) = block.get("thinking").and_then(Value::as_array) {
                        for part in parts {
                            events.extend(
                                self.text_delta(part.get("text").and_then(Value::as_str).unwrap_or_default(), true),
                            );
                        }
                    }
                } else {
                    events
                        .extend(self.text_delta(block.get("text").and_then(Value::as_str).unwrap_or_default(), false));
                }
            }
        }
        if let Some(text) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
        {
            events.extend(self.text_delta(text, true));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let function = call.get("function").unwrap_or(&Value::Null);
                let arguments = function
                    .get("arguments")
                    .map(|value| value.as_str().map_or_else(|| value.to_string(), str::to_owned))
                    .unwrap_or_default();
                events.extend(self.tool_delta(
                    index,
                    call.get("id").and_then(Value::as_str),
                    function.get("name").and_then(Value::as_str),
                    &arguments,
                ));
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.message.raw_stop_reason = Some(reason.to_owned());
            self.message.stop_reason = map_stop(reason);
        }
        events
    }

    fn responses(&mut self, value: &Value) -> Vec<Event> {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "response.output_text.delta" => {
                self.text_delta(value.get("delta").and_then(Value::as_str).unwrap_or_default(), false)
            }
            "response.reasoning_summary_text.delta" => {
                self.text_delta(value.get("delta").and_then(Value::as_str).unwrap_or_default(), true)
            }
            "response.output_item.added" => {
                let item = value.get("item").unwrap_or(&Value::Null);
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    self.tool_delta(
                        value.get("output_index").and_then(Value::as_u64).unwrap_or(0) as usize,
                        item.get("call_id").and_then(Value::as_str),
                        item.get("name").and_then(Value::as_str),
                        item.get("arguments").and_then(Value::as_str).unwrap_or_default(),
                    )
                } else {
                    Vec::new()
                }
            }
            "response.function_call_arguments.delta" => self.tool_delta(
                value.get("output_index").and_then(Value::as_u64).unwrap_or(0) as usize,
                None,
                None,
                value.get("delta").and_then(Value::as_str).unwrap_or_default(),
            ),
            "response.completed" => {
                if let Some(response) = value.get("response") {
                    self.message.response_id = response.get("id").and_then(Value::as_str).map(str::to_owned);
                    if let Some(usage) = response.get("usage") {
                        self.read_responses_usage(usage);
                    }
                }
                self.finish(
                    if self.tools.is_empty() {
                        StopReason::Stop
                    } else {
                        StopReason::ToolUse
                    },
                    None,
                )
            }
            "response.failed" | "error" => self.finish(
                StopReason::Error,
                Some(
                    value
                        .pointer("/response/error/message")
                        .or_else(|| value.pointer("/error/message"))
                        .and_then(Value::as_str)
                        .unwrap_or("provider response failed"),
                ),
            ),
            _ => Vec::new(),
        }
    }

    fn anthropic(&mut self, value: &Value) -> Vec<Event> {
        match value.get("type").and_then(Value::as_str).unwrap_or_default() {
            "message_start" => {
                if let Some(message) = value.get("message") {
                    self.message.response_id = message.get("id").and_then(Value::as_str).map(str::to_owned);
                    if let Some(usage) = message.get("usage") {
                        self.read_anthropic_usage(usage);
                    }
                }
                Vec::new()
            }
            "content_block_start" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let block = value.get("content_block").unwrap_or(&Value::Null);
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => self.tool_delta(
                        index,
                        block.get("id").and_then(Value::as_str),
                        block.get("name").and_then(Value::as_str),
                        "",
                    ),
                    Some("thinking") => {
                        self.text_delta(block.get("thinking").and_then(Value::as_str).unwrap_or_default(), true)
                    }
                    _ => self.text_delta(block.get("text").and_then(Value::as_str).unwrap_or_default(), false),
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta = value.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("input_json_delta") => self.tool_delta(
                        index,
                        None,
                        None,
                        delta.get("partial_json").and_then(Value::as_str).unwrap_or_default(),
                    ),
                    Some("thinking_delta") => {
                        self.text_delta(delta.get("thinking").and_then(Value::as_str).unwrap_or_default(), true)
                    }
                    _ => self.text_delta(delta.get("text").and_then(Value::as_str).unwrap_or_default(), false),
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage") {
                    self.read_anthropic_usage(usage);
                }
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.message.stop_reason = map_stop(reason);
                    self.message.raw_stop_reason = Some(reason.to_owned());
                }
                Vec::new()
            }
            "message_stop" => self.finish(self.message.stop_reason, None),
            "error" => self.finish(
                StopReason::Error,
                Some(
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("provider error"),
                ),
            ),
            _ => Vec::new(),
        }
    }

    fn google(&mut self, value: &Value) -> Vec<Event> {
        let mut events = Vec::new();
        if let Some(parts) = value.pointer("/candidates/0/content/parts").and_then(Value::as_array) {
            for (index, part) in parts.iter().enumerate() {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    events.extend(self.text_delta(text, part.get("thought").and_then(Value::as_bool).unwrap_or(false)));
                } else if let Some(call) = part.get("functionCall") {
                    let arguments = call.get("args").cloned().unwrap_or_else(|| json!({})).to_string();
                    events.extend(self.tool_delta(
                        index,
                        Some(&format!("call_{}", uuid::Uuid::new_v4())),
                        call.get("name").and_then(Value::as_str),
                        &arguments,
                    ));
                }
            }
        }
        if let Some(usage) = value.get("usageMetadata") {
            self.message.usage.input = usage.get("promptTokenCount").and_then(Value::as_u64).unwrap_or(0);
            self.message.usage.output = usage.get("candidatesTokenCount").and_then(Value::as_u64).unwrap_or(0);
            self.message.usage.total_tokens = usage.get("totalTokenCount").and_then(Value::as_u64).unwrap_or(0);
        }
        if let Some(reason) = value.pointer("/candidates/0/finishReason").and_then(Value::as_str) {
            self.message.stop_reason = map_stop(reason);
            self.message.raw_stop_reason = Some(reason.to_owned());
        }
        events
    }

    fn finish(&mut self, mut reason: StopReason, error: Option<&str>) -> Vec<Event> {
        if self.terminal {
            return Vec::new();
        }
        self.terminal = true;
        let mut events = Vec::new();
        for block in &self.message.content {
            let index = events.len();
            match block {
                Content::Text { text, .. } => events.push(Event::TextEnd {
                    content_index: index,
                    content: text.clone(),
                    partial: self.message.clone(),
                }),
                Content::Thinking { thinking, .. } => events.push(Event::ThinkingEnd {
                    content_index: index,
                    content: thinking.clone(),
                    partial: self.message.clone(),
                }),
                Content::ToolCall { .. } => events.push(Event::ToolcallEnd {
                    content_index: index,
                    tool_call: block.clone(),
                    partial: self.message.clone(),
                }),
                Content::Image { .. } => {}
            }
        }
        if !self.tools.is_empty() && reason == StopReason::Pending {
            reason = StopReason::ToolUse;
        } else if reason == StopReason::Pending {
            reason = StopReason::Stop;
        }
        self.message.stop_reason = reason;
        self.message.error_message = error.map(str::to_owned);
        self.message.usage.calculate_cost(&self.cost);
        if reason == StopReason::Error || reason == StopReason::Aborted {
            events.push(Event::Error {
                reason,
                error: self.message.clone(),
            });
        } else {
            events.push(Event::Done {
                reason,
                message: self.message.clone(),
            });
        }
        events
    }

    fn read_openai_usage(&mut self, usage: &Value) {
        self.message.usage.input = usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.message.usage.output = usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.message.usage.total_tokens = usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.message.usage.cache_read = usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.message.usage.reasoning = usage
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64);
    }

    fn read_responses_usage(&mut self, usage: &Value) {
        self.message.usage.input = usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.message.usage.output = usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
        self.message.usage.total_tokens = self.message.usage.input + self.message.usage.output;
        self.message.usage.cache_read = usage
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.message.usage.reasoning = usage
            .pointer("/output_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64);
    }

    fn read_anthropic_usage(&mut self, usage: &Value) {
        self.message.usage.input = usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(self.message.usage.input);
        self.message.usage.output = usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(self.message.usage.output);
        self.message.usage.cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.message.usage.cache_write = usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.message.usage.total_tokens = self.message.usage.input + self.message.usage.output;
    }
}

fn parse_partial_json(text: &str) -> Value {
    if text.is_empty() {
        return json!({});
    }
    if let Ok(value) = serde_json::from_str(text) {
        return value;
    }
    let mut candidate = text.to_owned();
    if candidate.matches('"').count() % 2 == 1 {
        candidate.push('"');
    }
    let open_braces = candidate
        .matches('{')
        .count()
        .saturating_sub(candidate.matches('}').count());
    let open_brackets = candidate
        .matches('[')
        .count()
        .saturating_sub(candidate.matches(']').count());
    candidate.extend(std::iter::repeat_n(']', open_brackets));
    candidate.extend(std::iter::repeat_n('}', open_braces));
    serde_json::from_str(&candidate).unwrap_or_else(|_| json!({}))
}

fn map_stop(reason: &str) -> StopReason {
    match reason.to_ascii_lowercase().as_str() {
        "max_tokens" | "length" | "max_tokens_exceeded" => StopReason::Length,
        "tool_calls" | "tool_use" | "function_call" => StopReason::ToolUse,
        "error" | "failed" => StopReason::Error,
        _ => StopReason::Stop,
    }
}
