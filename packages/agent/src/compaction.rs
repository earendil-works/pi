use pi_ai::{Content, Message, Model, Models, StreamOptions, Usage, estimate_tokens};

use crate::AgentError;

#[derive(Clone, Debug)]
pub struct CompactionSettings {
    pub enabled: bool,
    pub reserve_tokens: u64,
    pub keep_recent_tokens: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            reserve_tokens: 16_384,
            keep_recent_tokens: 20_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct CompactResult {
    pub summary: String,
    pub retained_tail: Vec<Message>,
    pub tokens_before: u64,
    pub usage: Usage,
}

#[must_use]
pub fn calculate_context_tokens(messages: &[Message]) -> u64 {
    if let Some(usage) = messages.iter().rev().find_map(|message| match message {
        Message::Assistant { message } => Some(&message.usage),
        _ => None,
    }) {
        usage.input + usage.cache_read + usage.cache_write + usage.output
    } else {
        estimate_tokens(messages)
    }
}

#[must_use]
pub fn should_compact(messages: &[Message], model: &Model, settings: &CompactionSettings) -> bool {
    settings.enabled && calculate_context_tokens(messages) + settings.reserve_tokens >= model.context_window
}

#[must_use]
pub fn find_turn_start_index(messages: &[Message], target_tail_tokens: u64) -> usize {
    let mut tokens = 0;
    for index in (0..messages.len()).rev() {
        tokens += estimate_tokens(&messages[index..=index]);
        if tokens >= target_tail_tokens {
            return (index..messages.len())
                .find(|candidate| matches!(messages[*candidate], Message::User { .. }))
                .unwrap_or(index);
        }
    }
    0
}

#[must_use]
pub fn serialize_conversation(messages: &[Message]) -> String {
    messages
        .iter()
        .map(|message| match message {
            Message::User { content, .. } => format!("User: {content:?}"),
            Message::Assistant { message } => format!("Assistant: {}", message.text()),
            Message::ToolResult {
                tool_name,
                content,
                is_error,
                ..
            } => format!(
                "Tool {tool_name}{}: {}",
                if *is_error { " (error)" } else { "" },
                content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn compact(
    models: &Models,
    model: &Model,
    messages: &[Message],
    settings: &CompactionSettings,
    custom_instructions: Option<&str>,
    options: StreamOptions,
) -> Result<CompactResult, AgentError> {
    let cut = find_turn_start_index(messages, settings.keep_recent_tokens);
    let (older, retained_tail) = messages.split_at(cut);
    let prompt = format!(
        "Summarize this conversation for another coding agent. Preserve decisions, changed files, commands, failures, and remaining work. {}\n\n{}",
        custom_instructions.unwrap_or_default(),
        serialize_conversation(older)
    );
    let context = pi_ai::Context {
        system_prompt: None,
        messages: vec![Message::user(prompt)],
        tools: Vec::new(),
    };
    let response = models.complete(model, &context, options).await?;
    Ok(CompactResult {
        summary: response.text(),
        retained_tail: retained_tail.to_vec(),
        tokens_before: calculate_context_tokens(messages),
        usage: response.usage,
    })
}
