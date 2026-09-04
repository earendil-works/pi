use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use pi_agent_core::{
    Agent, AgentEvent, AgentOptions, CompactionSettings as CoreCompactionSettings, SessionEntryData, SessionManager,
    compact, create_coding_tools,
};
use pi_ai::{Content, Message, Model, Models, StreamOptions, ThinkingLevel};
use tokio::sync::{Mutex, broadcast};

use crate::{Resources, Settings, format_skills_prompt, prompt_map};

pub struct AgentSession {
    pub agent: Arc<Agent>,
    pub session_manager: Arc<Mutex<SessionManager>>,
    pub resources: Arc<Resources>,
    models: Models,
    settings: Settings,
    auto_compaction: AtomicBool,
    auto_retry: AtomicBool,
    cwd: PathBuf,
}
impl AgentSession {
    pub fn new(
        models: Models,
        model: Model,
        settings: Settings,
        resources: Resources,
        session_manager: SessionManager,
        cwd: PathBuf,
        tools: Option<Vec<Arc<dyn pi_agent_core::AgentTool>>>,
        hooks: Option<Arc<dyn pi_agent_core::AgentHooks>>,
        system_override: Option<String>,
        append_system: Option<String>,
    ) -> Self {
        let context = session_manager.build_context();
        let mut selected_tools = tools.unwrap_or_else(|| create_coding_tools(&cwd));
        if let Some(default_tools) = &settings.default_tools {
            selected_tools.retain(|tool| default_tools.contains(&tool.name().to_owned()))
        }
        let system_prompt = build_system_prompt(
            &cwd,
            &resources,
            &selected_tools,
            system_override.as_deref(),
            append_system.as_deref(),
        );
        let mut options = AgentOptions::new(model);
        options.system_prompt = system_prompt;
        options.thinking_level = context.thinking_level.unwrap_or(settings.default_thinking_level);
        options.tools = selected_tools;
        options.hooks = hooks;
        options.messages = context.messages;
        options.stream_options = StreamOptions {
            transport: settings.transport,
            timeout_ms: settings.retry.provider.timeout_ms,
            max_retries: Some(settings.retry.provider.max_retries),
            ..StreamOptions::default()
        };
        options.session_id = Some(session_manager.header().id.clone());
        let agent = Arc::new(Agent::new(models.clone(), options));
        let session_manager = Arc::new(Mutex::new(session_manager));
        let resources = Arc::new(resources);
        Self {
            agent,
            session_manager,
            resources,
            models,
            auto_compaction: AtomicBool::new(settings.compaction.enabled),
            auto_retry: AtomicBool::new(settings.retry.enabled),
            settings,
            cwd,
        }
    }
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.agent.subscribe()
    }
    #[must_use]
    pub fn model(&self) -> Model {
        self.agent.state().model()
    }
    #[must_use]
    pub fn thinking_level(&self) -> ThinkingLevel {
        self.agent.state().thinking_level()
    }
    #[must_use]
    pub fn messages(&self) -> Vec<Message> {
        self.agent.state().messages()
    }
    #[must_use]
    pub fn is_streaming(&self) -> bool {
        self.agent.state().is_streaming()
    }
    pub async fn prompt(&self, text: &str, streaming_behavior: Option<&str>) -> Result<(), pi_agent_core::AgentError> {
        let expanded = self.expand_prompt(text).await;
        let user_message = Message::user(expanded);
        if self.is_streaming() {
            match streaming_behavior {
                Some("steer") => self.agent.steer(user_message),
                Some("followUp") | Some("follow_up") => self.agent.follow_up(user_message),
                _ => return Err(pi_agent_core::AgentError::Busy),
            }
            Ok(())
        } else {
            let compaction_settings = CoreCompactionSettings {
                enabled: self.auto_compaction.load(Ordering::Relaxed),
                reserve_tokens: self.settings.compaction.reserve_tokens,
                keep_recent_tokens: self.settings.compaction.keep_recent_tokens,
            };
            if !self.messages().is_empty()
                && pi_agent_core::should_compact(&self.messages(), &self.model(), &compaction_settings)
            {
                self.compact(None).await?;
            }
            let mut messages = self.agent.prompt_message(user_message).await?;
            let mut attempt = 0;
            while self.auto_retry.load(Ordering::Relaxed) && attempt < self.settings.retry.max_retries {
                let error = messages.iter().rev().find_map(|message| match message {
                    Message::Assistant { message } if message.stop_reason == pi_ai::StopReason::Error => {
                        message.error_message.as_deref()
                    }
                    _ => None,
                });
                let Some(error) = error.filter(|error| is_transient_error(error)) else {
                    break;
                };
                attempt += 1;
                let delay = self
                    .settings
                    .retry
                    .base_delay_ms
                    .saturating_mul(1_u64 << (attempt - 1).min(16));
                eprintln!("Transient provider error; retrying in {delay}ms: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                let mut state_messages = self.agent.state().messages();
                if matches!(state_messages.last(), Some(Message::Assistant { .. })) {
                    state_messages.pop();
                    self.agent.state().set_messages(state_messages);
                }
                messages.extend(self.agent.continue_run().await?);
            }
            let retry_succeeded = matches!(messages.last(), Some(Message::Assistant { message }) if message.stop_reason != pi_ai::StopReason::Error);
            let mut manager = self.session_manager.lock().await;
            for message in messages {
                if retry_succeeded
                    && matches!(&message, Message::Assistant { message } if message.stop_reason == pi_ai::StopReason::Error)
                {
                    continue;
                }
                manager
                    .append_message(message)
                    .await
                    .map_err(|error| pi_agent_core::AgentError::Tool {
                        tool: "session".into(),
                        message: error.to_string(),
                    })?;
            }
            Ok(())
        }
    }
    pub async fn prompt_with_images(
        &self,
        text: &str,
        images: Vec<Content>,
        streaming_behavior: Option<&str>,
    ) -> Result<(), pi_agent_core::AgentError> {
        let mut blocks = vec![Content::text(self.expand_prompt(text).await)];
        blocks.extend(images);
        let message = Message::User {
            content: pi_ai::UserContent::Blocks(blocks),
            timestamp: chrono::Utc::now().timestamp_millis(),
        };
        if self.is_streaming() {
            match streaming_behavior {
                Some("steer") => self.agent.steer(message),
                Some("followUp") | Some("follow_up") => self.agent.follow_up(message),
                _ => return Err(pi_agent_core::AgentError::Busy),
            }
            return Ok(());
        }
        let generated = self.agent.prompt_message(message).await?;
        let mut manager = self.session_manager.lock().await;
        for message in generated {
            manager
                .append_message(message)
                .await
                .map_err(|error| pi_agent_core::AgentError::Tool {
                    tool: "session".into(),
                    message: error.to_string(),
                })?;
        }
        Ok(())
    }

    pub async fn steer(&self, text: &str) {
        self.agent.steer(Message::user(self.expand_prompt(text).await))
    }
    pub async fn follow_up(&self, text: &str) {
        self.agent.follow_up(Message::user(self.expand_prompt(text).await))
    }
    async fn expand_prompt(&self, text: &str) -> String {
        if let Some(value) = text.strip_prefix("/skill:") {
            let (name, args) = value.split_once(' ').unwrap_or((value, ""));
            if let Some(skill) = self.resources.skills.iter().find(|skill| skill.name == name)
                && let Ok(content) = tokio::fs::read_to_string(&skill.path).await
            {
                return if args.is_empty() {
                    content
                } else {
                    format!("{content}\n\nUser: {args}")
                };
            }
        }
        if let Some(value) = text.strip_prefix('/') {
            let (name, args) = value.split_once(' ').unwrap_or((value, ""));
            if let Some(template) = prompt_map(&self.resources).get(name) {
                return template.expand(args);
            }
        }
        text.into()
    }
    pub async fn set_model(&self, model: Model) -> Result<(), pi_agent_core::SessionError> {
        self.agent.state().set_model(model.clone());
        self.session_manager
            .lock()
            .await
            .append_model_change(model.provider, model.id)
            .await?;
        Ok(())
    }
    pub async fn set_thinking_level(&self, level: ThinkingLevel) -> Result<(), pi_agent_core::SessionError> {
        self.agent.state().set_thinking_level(level);
        self.session_manager
            .lock()
            .await
            .append_thinking_level_change(level)
            .await?;
        Ok(())
    }
    pub async fn compact(
        &self,
        instructions: Option<&str>,
    ) -> Result<pi_agent_core::CompactResult, pi_agent_core::AgentError> {
        let messages = self.messages();
        let model = self.model();
        let settings = CoreCompactionSettings {
            enabled: self.settings.compaction.enabled,
            reserve_tokens: self.settings.compaction.reserve_tokens,
            keep_recent_tokens: self.settings.compaction.keep_recent_tokens,
        };
        let result = compact(
            &self.models,
            &model,
            &messages,
            &settings,
            instructions,
            StreamOptions::default(),
        )
        .await?;
        self.session_manager
            .lock()
            .await
            .append(SessionEntryData::Compaction {
                summary: result.summary.clone(),
                first_kept_entry_id: None,
                tokens_before: result.tokens_before,
                retained_tail: result.retained_tail.clone(),
                usage: Some(result.usage.clone()),
                details: None,
                from_hook: false,
            })
            .await
            .map_err(|error| pi_agent_core::AgentError::Tool {
                tool: "compact".into(),
                message: error.to_string(),
            })?;
        let mut new_messages = vec![Message::user(format!("Conversation summary:\n{}", result.summary))];
        new_messages.extend(result.retained_tail.clone());
        self.agent.state().set_messages(new_messages);
        Ok(result)
    }
    pub async fn new_session(
        &self,
        session_root: &std::path::Path,
        persistent: bool,
    ) -> Result<(), pi_agent_core::SessionError> {
        self.wait_for_idle().await;
        let manager = if persistent {
            SessionManager::create(&self.cwd, session_root).await?
        } else {
            SessionManager::in_memory(&self.cwd)
        };
        *self.session_manager.lock().await = manager;
        self.agent.reset();
        Ok(())
    }

    pub async fn switch_session(&self, path: &std::path::Path) -> Result<(), pi_agent_core::SessionError> {
        self.wait_for_idle().await;
        let manager = SessionManager::open(path).await?;
        let context = manager.build_context();
        if let Some((provider, model_id)) = &context.model
            && let Some(model) = self.models.get_model(provider, model_id)
        {
            self.agent.state().set_model(model);
        }
        if let Some(level) = context.thinking_level {
            self.agent.state().set_thinking_level(level);
        }
        self.agent.state().set_messages(context.messages);
        *self.session_manager.lock().await = manager;
        Ok(())
    }

    pub async fn fork_session(
        &self,
        entry_id: &str,
        session_root: &std::path::Path,
    ) -> Result<(), pi_agent_core::SessionError> {
        self.wait_for_idle().await;
        let manager = self
            .session_manager
            .lock()
            .await
            .create_branched_session(entry_id, session_root)
            .await?;
        let context = manager.build_context();
        self.agent.state().set_messages(context.messages);
        *self.session_manager.lock().await = manager;
        Ok(())
    }

    pub fn set_auto_compaction(&self, enabled: bool) {
        self.auto_compaction.store(enabled, Ordering::Relaxed);
    }
    pub fn set_auto_retry(&self, enabled: bool) {
        self.auto_retry.store(enabled, Ordering::Relaxed);
    }
    #[must_use]
    pub fn auto_compaction(&self) -> bool {
        self.auto_compaction.load(Ordering::Relaxed)
    }
    #[must_use]
    pub fn auto_retry(&self) -> bool {
        self.auto_retry.load(Ordering::Relaxed)
    }

    pub fn abort(&self) {
        self.agent.abort()
    }
    pub async fn wait_for_idle(&self) {
        self.agent.wait_for_idle().await
    }
    #[must_use]
    pub fn cwd(&self) -> &PathBuf {
        &self.cwd
    }
}

#[must_use]
pub fn build_system_prompt(
    cwd: &PathBuf,
    resources: &Resources,
    tools: &[Arc<dyn pi_agent_core::AgentTool>],
    override_prompt: Option<&str>,
    append: Option<&str>,
) -> String {
    let mut prompt=override_prompt.map_or_else(||"You are an expert coding assistant. Use the available tools to inspect, modify, and verify the project. Be concise and complete tasks end-to-end.".to_owned(),str::to_owned);
    prompt.push_str(&format!(
        "\n\nWorking directory: {}\n\nAvailable tools:\n",
        cwd.display()
    ));
    for tool in tools {
        prompt.push_str(&format!("- {}: {}\n", tool.name(), tool.description()))
    }
    if !resources.context_files.is_empty() {
        prompt.push_str("\nProject instructions:\n");
        for file in &resources.context_files {
            prompt.push_str(&format!("\n--- {} ---\n{}\n", file.path.display(), file.content))
        }
    }
    prompt.push_str(&format_skills_prompt(&resources.skills));
    if let Some(append) = append {
        prompt.push_str("\n\n");
        prompt.push_str(append)
    }
    prompt
}

#[must_use]
fn is_transient_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "429",
        "500",
        "502",
        "503",
        "504",
        "529",
        "overloaded",
        "rate limit",
        "connection reset",
        "timed out",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

#[must_use]
pub fn last_assistant_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant { message } => Some(
                message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}
