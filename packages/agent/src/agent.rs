use std::{collections::VecDeque, sync::Arc};

use async_trait::async_trait;
use futures::{StreamExt, stream::FuturesUnordered};
use parking_lot::{Mutex, RwLock};
use pi_ai::{
    AssistantMessage, AssistantMessageEvent, Content, Context, Message, Model, Models, StopReason, StreamOptions, Tool,
    Usage, validate_tool_call,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolExecutionMode {
    Sequential,
    #[default]
    Parallel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QueueMode {
    All,
    #[default]
    OneAtATime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentToolResult {
    pub content: Vec<Content>,
    #[serde(default)]
    pub details: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub added_tool_names: Vec<String>,
    #[serde(default)]
    pub terminate: bool,
}

impl AgentToolResult {
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![Content::text(text)],
            details: Value::Object(Default::default()),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        }
    }
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent is already running")]
    Busy,
    #[error("the conversation cannot continue after an assistant message")]
    InvalidContinuation,
    #[error("AI request failed: {0}")]
    Ai(#[from] pi_ai::AiError),
    #[error("tool {tool} failed: {message}")]
    Tool { tool: String, message: String },
    #[error("agent was aborted")]
    Aborted,
}

#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> Value;
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        None
    }
    async fn execute(
        &self,
        call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError>;

    async fn execute_with_updates(
        &self,
        call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
        _on_update: Arc<dyn Fn(AgentToolResult) + Send + Sync>,
    ) -> Result<AgentToolResult, AgentError> {
        self.execute(call_id, parameters, cancellation).await
    }

    fn definition(&self) -> Tool {
        Tool {
            name: self.name().to_owned(),
            description: self.description().to_owned(),
            parameters: self.parameters(),
            constrained_sampling: None,
        }
    }
}

#[derive(Clone)]
pub struct AgentState {
    inner: Arc<RwLock<StateInner>>,
}

struct StateInner {
    system_prompt: String,
    model: Model,
    thinking_level: pi_ai::ThinkingLevel,
    tools: Vec<Arc<dyn AgentTool>>,
    messages: Vec<Message>,
    is_streaming: bool,
    streaming_message: Option<AssistantMessage>,
    pending_tool_calls: Vec<String>,
    error_message: Option<String>,
}

impl AgentState {
    #[must_use]
    pub fn system_prompt(&self) -> String {
        self.inner.read().system_prompt.clone()
    }

    pub fn set_system_prompt(&self, prompt: impl Into<String>) {
        self.inner.write().system_prompt = prompt.into();
    }

    #[must_use]
    pub fn model(&self) -> Model {
        self.inner.read().model.clone()
    }

    pub fn set_model(&self, model: Model) {
        self.inner.write().model = model;
    }

    #[must_use]
    pub fn thinking_level(&self) -> pi_ai::ThinkingLevel {
        self.inner.read().thinking_level
    }

    pub fn set_thinking_level(&self, level: pi_ai::ThinkingLevel) {
        self.inner.write().thinking_level = level;
    }

    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn AgentTool>> {
        self.inner.read().tools.clone()
    }

    pub fn set_tools(&self, tools: Vec<Arc<dyn AgentTool>>) {
        self.inner.write().tools = tools;
    }

    #[must_use]
    pub fn messages(&self) -> Vec<Message> {
        self.inner.read().messages.clone()
    }

    pub fn set_messages(&self, messages: Vec<Message>) {
        self.inner.write().messages = messages;
    }

    #[must_use]
    pub fn is_streaming(&self) -> bool {
        self.inner.read().is_streaming
    }

    #[must_use]
    pub fn streaming_message(&self) -> Option<AssistantMessage> {
        self.inner.read().streaming_message.clone()
    }

    #[must_use]
    pub fn pending_tool_calls(&self) -> Vec<String> {
        self.inner.read().pending_tool_calls.clone()
    }

    #[must_use]
    pub fn error_message(&self) -> Option<String> {
        self.inner.read().error_message.clone()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        messages: Vec<Message>,
    },
    TurnStart,
    TurnEnd {
        message: AssistantMessage,
        tool_results: Vec<Message>,
    },
    MessageStart {
        message: Message,
    },
    MessageUpdate {
        message: AssistantMessage,
        assistant_message_event: AssistantMessageEvent,
    },
    MessageEnd {
        message: Message,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        args: Value,
        partial_result: AgentToolResult,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        result: AgentToolResult,
        is_error: bool,
    },
    QueueUpdate {
        steering: Vec<Message>,
        follow_up: Vec<Message>,
    },
}

#[derive(Clone, Debug, Default)]
pub struct BeforeToolDecision {
    pub block: bool,
    pub reason: Option<String>,
    pub terminate: bool,
}
#[derive(Clone, Debug, Default)]
pub struct AfterToolDecision {
    pub content: Option<Vec<Content>>,
    pub details: Option<Value>,
    pub is_error: Option<bool>,
    pub usage: Option<Usage>,
    pub terminate: Option<bool>,
}

#[async_trait]
pub trait AgentHooks: Send + Sync {
    async fn transform_context(&self, messages: Vec<Message>, _cancellation: CancellationToken) -> Vec<Message> {
        messages
    }
    async fn before_tool_call(
        &self,
        _assistant: &AssistantMessage,
        _call: &Content,
        _args: &Value,
        _context: &Context,
        _cancellation: CancellationToken,
    ) -> BeforeToolDecision {
        BeforeToolDecision::default()
    }
    async fn after_tool_call(
        &self,
        _assistant: &AssistantMessage,
        _call: &Content,
        _args: &Value,
        _context: &Context,
        _result: &AgentToolResult,
        _is_error: bool,
        _cancellation: CancellationToken,
    ) -> AfterToolDecision {
        AfterToolDecision::default()
    }
    async fn should_stop_after_turn(
        &self,
        _assistant: &AssistantMessage,
        _tool_results: &[Message],
        _context: &Context,
        _cancellation: CancellationToken,
    ) -> bool {
        false
    }
}

#[derive(Clone)]
pub struct AgentOptions {
    pub system_prompt: String,
    pub model: Model,
    pub thinking_level: pi_ai::ThinkingLevel,
    pub tools: Vec<Arc<dyn AgentTool>>,
    pub messages: Vec<Message>,
    pub stream_options: StreamOptions,
    pub tool_execution: ToolExecutionMode,
    pub steering_mode: QueueMode,
    pub follow_up_mode: QueueMode,
    pub session_id: Option<String>,
    pub hooks: Option<Arc<dyn AgentHooks>>,
}

impl AgentOptions {
    #[must_use]
    pub fn new(model: Model) -> Self {
        Self {
            system_prompt: String::new(),
            model,
            thinking_level: pi_ai::ThinkingLevel::Off,
            tools: Vec::new(),
            messages: Vec::new(),
            stream_options: StreamOptions::default(),
            tool_execution: ToolExecutionMode::Parallel,
            steering_mode: QueueMode::OneAtATime,
            follow_up_mode: QueueMode::OneAtATime,
            session_id: None,
            hooks: None,
        }
    }
}

pub struct Agent {
    models: Models,
    state: AgentState,
    events: broadcast::Sender<AgentEvent>,
    run_gate: AsyncMutex<()>,
    cancellation: Mutex<CancellationToken>,
    steering: Mutex<VecDeque<Message>>,
    follow_up: Mutex<VecDeque<Message>>,
    config: RwLock<AgentConfig>,
}

struct AgentConfig {
    stream_options: StreamOptions,
    tool_execution: ToolExecutionMode,
    steering_mode: QueueMode,
    follow_up_mode: QueueMode,
    session_id: Option<String>,
    hooks: Option<Arc<dyn AgentHooks>>,
}

impl Agent {
    #[must_use]
    pub fn new(models: Models, options: AgentOptions) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            models,
            state: AgentState {
                inner: Arc::new(RwLock::new(StateInner {
                    system_prompt: options.system_prompt,
                    model: options.model,
                    thinking_level: options.thinking_level,
                    tools: options.tools,
                    messages: options.messages,
                    is_streaming: false,
                    streaming_message: None,
                    pending_tool_calls: Vec::new(),
                    error_message: None,
                })),
            },
            events,
            run_gate: AsyncMutex::new(()),
            cancellation: Mutex::new(CancellationToken::new()),
            steering: Mutex::new(VecDeque::new()),
            follow_up: Mutex::new(VecDeque::new()),
            config: RwLock::new(AgentConfig {
                stream_options: options.stream_options,
                tool_execution: options.tool_execution,
                steering_mode: options.steering_mode,
                follow_up_mode: options.follow_up_mode,
                session_id: options.session_id,
                hooks: options.hooks,
            }),
        }
    }

    #[must_use]
    pub fn state(&self) -> AgentState {
        self.state.clone()
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.events.subscribe()
    }

    pub fn abort(&self) {
        self.cancellation.lock().cancel();
    }

    pub async fn wait_for_idle(&self) {
        let _guard = self.run_gate.lock().await;
    }

    pub fn steer(&self, message: Message) {
        self.steering.lock().push_back(message);
        self.emit_queue();
    }

    pub fn follow_up(&self, message: Message) {
        self.follow_up.lock().push_back(message);
        self.emit_queue();
    }

    pub fn clear_steering_queue(&self) {
        self.steering.lock().clear();
        self.emit_queue();
    }

    pub fn clear_follow_up_queue(&self) {
        self.follow_up.lock().clear();
        self.emit_queue();
    }

    pub fn clear_all_queues(&self) {
        self.steering.lock().clear();
        self.follow_up.lock().clear();
        self.emit_queue();
    }

    pub fn take_all_queues(&self) -> (Vec<Message>, Vec<Message>) {
        let steering = self.steering.lock().drain(..).collect();
        let follow_up = self.follow_up.lock().drain(..).collect();
        self.emit_queue();
        (steering, follow_up)
    }

    pub fn set_steering_mode(&self, mode: QueueMode) {
        self.config.write().steering_mode = mode;
    }
    pub fn set_follow_up_mode(&self, mode: QueueMode) {
        self.config.write().follow_up_mode = mode;
    }
    #[must_use]
    pub fn steering_mode(&self) -> QueueMode {
        self.config.read().steering_mode
    }
    #[must_use]
    pub fn follow_up_mode(&self) -> QueueMode {
        self.config.read().follow_up_mode
    }

    pub fn reset(&self) {
        if self.state.is_streaming() {
            self.abort();
        }
        let mut state = self.state.inner.write();
        state.messages.clear();
        state.streaming_message = None;
        state.pending_tool_calls.clear();
        state.error_message = None;
    }

    pub async fn prompt(&self, text: impl Into<String>) -> Result<Vec<Message>, AgentError> {
        self.run(vec![Message::user(text)]).await
    }

    pub async fn prompt_message(&self, message: Message) -> Result<Vec<Message>, AgentError> {
        self.run(vec![message]).await
    }

    pub async fn continue_run(&self) -> Result<Vec<Message>, AgentError> {
        if matches!(self.state.messages().last(), None | Some(Message::Assistant { .. })) {
            return Err(AgentError::InvalidContinuation);
        }
        self.run(Vec::new()).await
    }

    async fn run(&self, initial_messages: Vec<Message>) -> Result<Vec<Message>, AgentError> {
        let _guard = self.run_gate.try_lock().map_err(|_| AgentError::Busy)?;
        let cancellation = CancellationToken::new();
        *self.cancellation.lock() = cancellation.clone();
        self.state.inner.write().is_streaming = true;
        let mut new_messages = Vec::new();
        self.emit(AgentEvent::AgentStart);
        for message in initial_messages {
            self.emit(AgentEvent::MessageStart {
                message: message.clone(),
            });
            self.state.inner.write().messages.push(message.clone());
            new_messages.push(message.clone());
            self.emit(AgentEvent::MessageEnd { message });
        }

        let result = self.drive(&cancellation, &mut new_messages).await;
        {
            let mut state = self.state.inner.write();
            state.is_streaming = false;
            state.streaming_message = None;
            state.pending_tool_calls.clear();
        }
        self.emit(AgentEvent::AgentEnd {
            messages: new_messages.clone(),
        });
        result.map(|()| new_messages)
    }

    async fn drive(&self, cancellation: &CancellationToken, new_messages: &mut Vec<Message>) -> Result<(), AgentError> {
        loop {
            if cancellation.is_cancelled() {
                return Err(AgentError::Aborted);
            }
            self.emit(AgentEvent::TurnStart);
            let (model, mut context, mut options) = {
                let state = self.state.inner.read();
                (
                    state.model.clone(),
                    Context {
                        system_prompt: Some(state.system_prompt.clone()),
                        messages: state.messages.clone(),
                        tools: state.tools.iter().map(|tool| tool.definition()).collect(),
                    },
                    self.config.read().stream_options.clone(),
                )
            };
            let turn_hooks = { self.config.read().hooks.clone() };
            if let Some(hooks) = turn_hooks {
                context.messages = hooks.transform_context(context.messages, cancellation.clone()).await;
            }
            options.reasoning = self.state.thinking_level();
            options.cancellation = Some(cancellation.clone());
            options.session_id.clone_from(&self.config.read().session_id);
            let mut stream = self.models.stream(&model, &context, options).await?;
            let mut assistant = None;
            while let Some(event) = stream.next().await {
                let partial = match &event {
                    AssistantMessageEvent::Start { partial }
                    | AssistantMessageEvent::TextStart { partial, .. }
                    | AssistantMessageEvent::TextDelta { partial, .. }
                    | AssistantMessageEvent::TextEnd { partial, .. }
                    | AssistantMessageEvent::ThinkingStart { partial, .. }
                    | AssistantMessageEvent::ThinkingDelta { partial, .. }
                    | AssistantMessageEvent::ThinkingEnd { partial, .. }
                    | AssistantMessageEvent::ToolcallStart { partial, .. }
                    | AssistantMessageEvent::ToolcallDelta { partial, .. }
                    | AssistantMessageEvent::ToolcallEnd { partial, .. } => Some(partial.clone()),
                    AssistantMessageEvent::Done { message, .. } => {
                        assistant = Some(message.clone());
                        None
                    }
                    AssistantMessageEvent::Error { error, .. } => {
                        assistant = Some(error.clone());
                        None
                    }
                };
                if let Some(partial) = partial {
                    let mut state = self.state.inner.write();
                    let first = state.streaming_message.is_none();
                    state.streaming_message = Some(partial.clone());
                    drop(state);
                    if first {
                        self.emit(AgentEvent::MessageStart {
                            message: Message::Assistant {
                                message: partial.clone(),
                            },
                        });
                    }
                    self.emit(AgentEvent::MessageUpdate {
                        message: partial,
                        assistant_message_event: event,
                    });
                }
            }
            let assistant =
                assistant.ok_or_else(|| AgentError::Ai(pi_ai::AiError::Protocol("missing terminal message".into())))?;
            let assistant_message = Message::Assistant {
                message: assistant.clone(),
            };
            if self.state.streaming_message().is_none() {
                self.emit(AgentEvent::MessageStart {
                    message: assistant_message.clone(),
                });
            }
            self.state.inner.write().messages.push(assistant_message.clone());
            new_messages.push(assistant_message.clone());
            self.state.inner.write().streaming_message = None;
            self.state
                .inner
                .write()
                .error_message
                .clone_from(&assistant.error_message);
            self.emit(AgentEvent::MessageEnd {
                message: assistant_message,
            });

            if matches!(assistant.stop_reason, StopReason::Error | StopReason::Aborted) {
                self.emit(AgentEvent::TurnEnd {
                    message: assistant,
                    tool_results: Vec::new(),
                });
                return Ok(());
            }

            let calls = assistant
                .content
                .iter()
                .filter_map(|content| match content {
                    Content::ToolCall {
                        id, name, arguments, ..
                    } => Some((id.clone(), name.clone(), arguments.clone(), content.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>();
            let results = self.execute_tools(&assistant, &context, calls, cancellation).await;
            let all_terminate = !results.is_empty() && results.iter().all(|result| result.1.terminate);
            let mut tool_messages = Vec::new();
            for (message, _) in results {
                self.emit(AgentEvent::MessageStart {
                    message: message.clone(),
                });
                self.state.inner.write().messages.push(message.clone());
                new_messages.push(message.clone());
                self.emit(AgentEvent::MessageEnd {
                    message: message.clone(),
                });
                tool_messages.push(message);
            }
            let stop_hooks = { self.config.read().hooks.clone() };
            let hook_stop = if let Some(hooks) = stop_hooks {
                hooks
                    .should_stop_after_turn(&assistant, &tool_messages, &context, cancellation.clone())
                    .await
            } else {
                false
            };
            self.emit(AgentEvent::TurnEnd {
                message: assistant,
                tool_results: tool_messages,
            });
            if all_terminate || hook_stop {
                return Ok(());
            }
            let steering = self.drain_queue(true);
            if !steering.is_empty() {
                self.append_queued(steering, new_messages);
                continue;
            }
            if !calls_are_empty(&self.state.messages()) {
                continue;
            }
            let follow_up = self.drain_queue(false);
            if follow_up.is_empty() {
                return Ok(());
            }
            self.append_queued(follow_up, new_messages);
        }
    }

    async fn execute_tools(
        &self,
        assistant: &AssistantMessage,
        context: &Context,
        calls: Vec<(String, String, Value, Content)>,
        cancellation: &CancellationToken,
    ) -> Vec<(Message, AgentToolResult)> {
        if calls.is_empty() {
            return Vec::new();
        }
        let tools = self.state.tools();
        let definitions = tools.iter().map(|tool| tool.definition()).collect::<Vec<_>>();
        self.state.inner.write().pending_tool_calls = calls.iter().map(|(id, ..)| id.clone()).collect();
        for (id, name, args, _) in &calls {
            self.emit(AgentEvent::ToolExecutionStart {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                args: args.clone(),
            });
        }
        let sequential = self.config.read().tool_execution == ToolExecutionMode::Sequential
            || calls.iter().any(|(_, name, ..)| {
                tools
                    .iter()
                    .find(|tool| tool.name() == name)
                    .and_then(|tool| tool.execution_mode())
                    == Some(ToolExecutionMode::Sequential)
            });
        let hooks = self.config.read().hooks.clone();
        let events = self.events.clone();
        let execute = |call: (String, String, Value, Content)| {
            let tools = tools.clone();
            let definitions = definitions.clone();
            let cancellation = cancellation.clone();
            let assistant = assistant.clone();
            let context = context.clone();
            let hooks = hooks.clone();
            let events = events.clone();
            async move {
                execute_one(
                    &tools,
                    &definitions,
                    call,
                    cancellation,
                    hooks,
                    &assistant,
                    &context,
                    events,
                )
                .await
            }
        };
        let mut results = Vec::new();
        if sequential {
            for call in calls {
                let result = execute(call).await;
                self.emit_tool_end(&result);
                results.push(result);
            }
        } else {
            let mut pending = calls.into_iter().map(execute).collect::<FuturesUnordered<_>>();
            while let Some(result) = pending.next().await {
                self.emit_tool_end(&result);
                results.push(result);
            }
        }
        results.sort_by_key(|result| {
            assistant
                .content
                .iter()
                .position(|block| {
                    matches!((block, result), (Content::ToolCall { id, .. }, ToolExecution { id: result_id, .. }) if id == result_id)
                })
                .unwrap_or(usize::MAX)
        });
        results
            .into_iter()
            .map(|execution| {
                let message = Message::ToolResult {
                    tool_call_id: execution.id,
                    tool_name: execution.name,
                    content: execution.result.content.clone(),
                    details: Some(execution.result.details.clone()),
                    usage: execution.result.usage.clone(),
                    added_tool_names: execution.result.added_tool_names.clone(),
                    is_error: execution.is_error,
                    timestamp: chrono::Utc::now().timestamp_millis(),
                };
                (message, execution.result)
            })
            .collect()
    }

    fn emit_tool_end(&self, execution: &ToolExecution) {
        self.emit(AgentEvent::ToolExecutionEnd {
            tool_call_id: execution.id.clone(),
            tool_name: execution.name.clone(),
            result: execution.result.clone(),
            is_error: execution.is_error,
        });
        self.state
            .inner
            .write()
            .pending_tool_calls
            .retain(|id| id != &execution.id);
    }

    fn append_queued(&self, messages: Vec<Message>, new_messages: &mut Vec<Message>) {
        for message in messages {
            self.emit(AgentEvent::MessageStart {
                message: message.clone(),
            });
            self.state.inner.write().messages.push(message.clone());
            new_messages.push(message.clone());
            self.emit(AgentEvent::MessageEnd { message });
        }
    }

    fn drain_queue(&self, steering: bool) -> Vec<Message> {
        let config = self.config.read();
        let mode = if steering {
            config.steering_mode
        } else {
            config.follow_up_mode
        };
        let mut queue = if steering {
            self.steering.lock()
        } else {
            self.follow_up.lock()
        };
        let result = match mode {
            QueueMode::All => queue.drain(..).collect(),
            QueueMode::OneAtATime => queue.pop_front().into_iter().collect(),
        };
        drop(queue);
        drop(config);
        self.emit_queue();
        result
    }

    fn emit(&self, event: AgentEvent) {
        let _ = self.events.send(event);
    }

    fn emit_queue(&self) {
        self.emit(AgentEvent::QueueUpdate {
            steering: self.steering.lock().iter().cloned().collect(),
            follow_up: self.follow_up.lock().iter().cloned().collect(),
        });
    }
}

struct ToolExecution {
    id: String,
    name: String,
    result: AgentToolResult,
    is_error: bool,
}

async fn execute_one(
    tools: &[Arc<dyn AgentTool>],
    definitions: &[Tool],
    call: (String, String, Value, Content),
    cancellation: CancellationToken,
    hooks: Option<Arc<dyn AgentHooks>>,
    assistant: &AssistantMessage,
    context: &Context,
    events: broadcast::Sender<AgentEvent>,
) -> ToolExecution {
    let (id, name, raw_args, content) = call;
    let validated = validate_tool_call(definitions, &content);
    let mut is_error = false;
    let mut result = match validated {
        Ok(args) => {
            let decision = if let Some(hooks) = &hooks {
                hooks
                    .before_tool_call(assistant, &content, &args, context, cancellation.clone())
                    .await
            } else {
                BeforeToolDecision::default()
            };
            if decision.block {
                is_error = true;
                let mut result =
                    AgentToolResult::text(decision.reason.unwrap_or_else(|| "Tool execution blocked".into()));
                result.terminate = decision.terminate;
                result
            } else {
                match tools.iter().find(|tool| tool.name() == name) {
                    Some(tool) => {
                        let update_id = id.clone();
                        let update_name = name.clone();
                        let update_args = raw_args.clone();
                        let on_update = Arc::new(move |partial_result| {
                            let _ = events.send(AgentEvent::ToolExecutionUpdate {
                                tool_call_id: update_id.clone(),
                                tool_name: update_name.clone(),
                                args: update_args.clone(),
                                partial_result,
                            });
                        });
                        match tool
                            .execute_with_updates(&id, args, cancellation.clone(), on_update)
                            .await
                        {
                            Ok(result) => result,
                            Err(error) => {
                                is_error = true;
                                AgentToolResult::text(error.to_string())
                            }
                        }
                    }
                    None => {
                        is_error = true;
                        AgentToolResult::text("tool not found")
                    }
                }
            }
        }
        Err(error) => {
            is_error = true;
            AgentToolResult::text(error.to_string())
        }
    };
    if let Some(hooks) = hooks {
        let patch = hooks
            .after_tool_call(assistant, &content, &raw_args, context, &result, is_error, cancellation)
            .await;
        if let Some(content) = patch.content {
            result.content = content;
        }
        if let Some(details) = patch.details {
            result.details = details;
        }
        if let Some(usage) = patch.usage {
            result.usage = Some(usage);
        }
        if let Some(terminate) = patch.terminate {
            result.terminate = terminate;
        }
        if let Some(error) = patch.is_error {
            is_error = error;
        }
    }
    ToolExecution {
        id,
        name,
        result,
        is_error,
    }
}

fn calls_are_empty(messages: &[Message]) -> bool {
    let assistant = messages.iter().rev().find_map(|message| match message {
        Message::Assistant { message } => Some(message),
        _ => None,
    });
    assistant.is_none_or(|message| {
        !message
            .content
            .iter()
            .any(|content| matches!(content, Content::ToolCall { .. }))
    })
}
