use std::{io::Write, sync::Arc};

use anyhow::Result;
use pi_agent_core::AgentEvent;
use pi_ai::{AssistantMessageEvent, Message, ThinkingLevel};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

use crate::{App, last_assistant_text, parse_thinking};

type Output = Arc<Mutex<tokio::io::Stdout>>;

pub async fn run_print(app: &App, messages: &[String], json_mode: bool) -> Result<()> {
    let output = Arc::new(Mutex::new(tokio::io::stdout()));
    if json_mode {
        write_json(
            &output,
            &serde_json::to_value(app.session.session_manager.lock().await.header())?,
        )
        .await?
    }
    let mut events = app.session.subscribe();
    let event_output = output.clone();
    let commands = app.extensions.commands();
    let expected = messages
        .iter()
        .filter(|message| {
            message
                .strip_prefix('/')
                .and_then(|value| value.split_whitespace().next())
                .is_none_or(|name| !commands.contains_key(name))
        })
        .count();
    let event_task = tokio::spawn(async move {
        let mut completed = 0;
        while let Ok(event) = events.recv().await {
            let is_end = matches!(&event, AgentEvent::AgentEnd { .. });
            if json_mode {
                let _ = write_json(&event_output, &agent_event_json(event)).await;
            } else if let AgentEvent::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::TextDelta { delta, .. },
                ..
            } = event
            {
                let mut output = event_output.lock().await;
                let _ = output.write_all(delta.as_bytes()).await;
                let _ = output.flush().await;
            }
            if is_end {
                completed += 1;
                if completed >= expected {
                    break;
                }
            }
        }
    });
    for message in messages {
        if let Some(command) = message.strip_prefix('/') {
            let (name, args) = command.split_once(' ').unwrap_or((command, ""));
            if let Some((_, executable, base)) = app.extensions.commands().get(name) {
                let value = crate::run_command(executable, base, args)
                    .await
                    .map_err(anyhow::Error::msg)?;
                if json_mode {
                    write_json(&output, &json!({"type":"extension_command","name":name,"result":value})).await?;
                } else {
                    let mut out = output.lock().await;
                    out.write_all(format!("{value}\n").as_bytes()).await?;
                }
                continue;
            }
        }
        app.session.prompt(message, None).await?
    }
    if expected > 0 {
        let _ = event_task.await;
    } else {
        event_task.abort();
    }
    if !json_mode {
        let mut output = output.lock().await;
        output.write_all(b"\n").await?;
        output.flush().await?
    }
    Ok(())
}

pub async fn run_rpc(app: Arc<App>) -> Result<()> {
    let output: Output = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut events = app.session.subscribe();
    let event_output = output.clone();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            let _ = write_json(&event_output, &agent_event_json(event)).await;
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let command: Value = match serde_json::from_str(line.trim_end_matches('\r')) {
            Ok(value) => value,
            Err(error) => {
                write_json(&output, &response(None, "parse", false, None, Some(error.to_string()))).await?;
                continue;
            }
        };
        let id = command.get("id").cloned();
        let kind = command.get("type").and_then(Value::as_str).unwrap_or("unknown");
        let result = handle_rpc(app.clone(), kind, &command).await;
        match result {
            Ok(data) => write_json(&output, &response(id, kind, true, data, None)).await?,
            Err(error) => write_json(&output, &response(id, kind, false, None, Some(error))).await?,
        }
    }
    Ok(())
}

async fn handle_rpc(app: Arc<App>, kind: &str, command: &Value) -> Result<Option<Value>, String> {
    match kind {
        "prompt" => {
            let message = required(command, "message")?.to_owned();
            if let Some(value) = message.strip_prefix('/') {
                let (name, args) = value.split_once(' ').unwrap_or((value, ""));
                if let Some((_, executable, base)) = app.extensions.commands().get(name) {
                    let result = crate::run_command(executable, base, args).await?;
                    return Ok(Some(json!({"handled":true,"result":result})));
                }
            }
            let behavior = command
                .get("streamingBehavior")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let images = command
                .get("images")
                .and_then(Value::as_array)
                .map(|images| {
                    images
                        .iter()
                        .filter_map(|image| serde_json::from_value::<pi_ai::Content>(image.clone()).ok())
                        .filter(|content| matches!(content, pi_ai::Content::Image { .. }))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if app.session.is_streaming() {
                app.session
                    .prompt_with_images(&message, images, behavior.as_deref())
                    .await
                    .map_err(|error| error.to_string())?;
            } else {
                let session = app.session.clone();
                tokio::spawn(async move {
                    let _ = session.prompt_with_images(&message, images, None).await;
                });
            }
            Ok(None)
        }
        "steer" => {
            app.session.steer(required(command, "message")?).await;
            Ok(None)
        }
        "follow_up" => {
            app.session.follow_up(required(command, "message")?).await;
            Ok(None)
        }
        "abort" => {
            app.session.abort();
            app.session.wait_for_idle().await;
            Ok(None)
        }
        "clear_queue" => {
            let (steering, follow_up) = app.session.agent.take_all_queues();
            Ok(Some(
                json!({"steering":steering.iter().map(message_text).collect::<Vec<_>>(),"followUp":follow_up.iter().map(message_text).collect::<Vec<_>>()}),
            ))
        }
        "set_steering_mode" => {
            app.session
                .agent
                .set_steering_mode(parse_queue_mode(required(command, "mode")?)?);
            Ok(None)
        }
        "set_follow_up_mode" => {
            app.session
                .agent
                .set_follow_up_mode(parse_queue_mode(required(command, "mode")?)?);
            Ok(None)
        }
        "new_session" => {
            app.session
                .new_session(&app.session_root, true)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(json!({"cancelled":false})))
        }
        "switch_session" => {
            let path = std::path::Path::new(required(command, "sessionPath")?);
            app.session
                .switch_session(path)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(json!({"cancelled":false})))
        }
        "fork" => {
            let entry = required(command, "entryId")?;
            app.session
                .fork_session(entry, &app.session_root)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(json!({"cancelled":false})))
        }
        "clone" => {
            let leaf = app
                .session
                .session_manager
                .lock()
                .await
                .leaf_id()
                .map(str::to_owned)
                .ok_or("session is empty")?;
            app.session
                .fork_session(&leaf, &app.session_root)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(json!({"cancelled":false})))
        }
        "export_html" => {
            let manager = app.session.session_manager.lock().await;
            let input = manager.file().ok_or("ephemeral session cannot be exported")?.to_owned();
            drop(manager);
            let requested = command
                .get("outputPath")
                .and_then(Value::as_str)
                .map(std::path::Path::new);
            let path = crate::export_session_html(&input, requested)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(json!({"path":path})))
        }
        "get_state" => {
            let manager = app.session.session_manager.lock().await;
            Ok(Some(
                json!({"model":app.session.model(),"thinkingLevel":app.session.thinking_level(),"isStreaming":app.session.is_streaming(),"isCompacting":false,"steeringMode":queue_mode_text(app.session.agent.steering_mode()),"followUpMode":queue_mode_text(app.session.agent.follow_up_mode()),"sessionFile":manager.file(),"sessionId":manager.header().id,"sessionName":manager.session_name(),"autoCompactionEnabled":app.session.auto_compaction(),"messageCount":app.session.messages().len(),"pendingMessageCount":0}),
            ))
        }
        "get_messages" => Ok(Some(json!({"messages":app.session.messages()}))),
        "get_available_models" => Ok(Some(
            json!({"models":app.model_runtime.models.get_available().await.map_err(|e|e.to_string())?}),
        )),
        "set_model" => {
            let provider = required(command, "provider")?;
            let id = required(command, "modelId")?;
            let model = app
                .model_runtime
                .models
                .get_model(provider, id)
                .ok_or_else(|| format!("Model not found: {provider}/{id}"))?;
            app.session.set_model(model.clone()).await.map_err(|e| e.to_string())?;
            Ok(Some(serde_json::to_value(model).map_err(|e| e.to_string())?))
        }
        "set_thinking_level" => {
            let level = parse_thinking(required(command, "level")?).ok_or("invalid thinking level")?;
            app.session.set_thinking_level(level).await.map_err(|e| e.to_string())?;
            Ok(None)
        }
        "get_available_thinking_levels" => {
            let levels = if app.session.model().reasoning {
                vec![
                    ThinkingLevel::Off,
                    ThinkingLevel::Minimal,
                    ThinkingLevel::Low,
                    ThinkingLevel::Medium,
                    ThinkingLevel::High,
                    ThinkingLevel::Xhigh,
                    ThinkingLevel::Max,
                ]
            } else {
                vec![ThinkingLevel::Off]
            };
            Ok(Some(json!({"levels":levels})))
        }
        "cycle_thinking_level" => {
            let levels = [
                ThinkingLevel::Off,
                ThinkingLevel::Minimal,
                ThinkingLevel::Low,
                ThinkingLevel::Medium,
                ThinkingLevel::High,
                ThinkingLevel::Xhigh,
                ThinkingLevel::Max,
            ];
            if !app.session.model().reasoning {
                return Ok(None);
            }
            let current = levels
                .iter()
                .position(|level| *level == app.session.thinking_level())
                .unwrap_or(0);
            let level = levels[(current + 1) % levels.len()];
            app.session.set_thinking_level(level).await.map_err(|e| e.to_string())?;
            Ok(Some(json!({"level":level})))
        }
        "cycle_model" => {
            let models = app
                .model_runtime
                .models
                .get_available()
                .await
                .map_err(|e| e.to_string())?;
            if models.len() < 2 {
                return Ok(None);
            }
            let current = models
                .iter()
                .position(|model| model.provider == app.session.model().provider && model.id == app.session.model().id)
                .unwrap_or(0);
            let model = models[(current + 1) % models.len()].clone();
            app.session.set_model(model.clone()).await.map_err(|e| e.to_string())?;
            Ok(Some(
                json!({"model":model,"thinkingLevel":app.session.thinking_level(),"isScoped":false}),
            ))
        }
        "set_auto_compaction" => {
            app.session.set_auto_compaction(
                command
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("missing enabled")?,
            );
            Ok(None)
        }
        "set_auto_retry" => {
            app.session.set_auto_retry(
                command
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("missing enabled")?,
            );
            Ok(None)
        }
        "abort_retry" => {
            app.session.abort();
            Ok(None)
        }
        "compact" => {
            let result = app
                .session
                .compact(command.get("customInstructions").and_then(Value::as_str))
                .await
                .map_err(|e| e.to_string())?;
            Ok(Some(
                json!({"summary":result.summary,"tokensBefore":result.tokens_before,"estimatedTokensAfter":pi_ai::estimate_tokens(&result.retained_tail),"usage":result.usage,"details":{}}),
            ))
        }
        "get_session_stats" => {
            let messages = app.session.messages();
            let mut input = 0_u64;
            let mut output_tokens = 0_u64;
            let mut cache_read = 0_u64;
            let mut cache_write = 0_u64;
            let mut cost = 0.0;
            let mut users = 0;
            let mut assistants = 0;
            let mut tool_results = 0;
            let mut tool_calls = 0;
            for message in &messages {
                match message {
                    Message::User { .. } => users += 1,
                    Message::Assistant { message } => {
                        assistants += 1;
                        input += message.usage.input;
                        output_tokens += message.usage.output;
                        cache_read += message.usage.cache_read;
                        cache_write += message.usage.cache_write;
                        cost += message.usage.cost.total;
                        tool_calls += message
                            .content
                            .iter()
                            .filter(|block| matches!(block, pi_ai::Content::ToolCall { .. }))
                            .count();
                    }
                    Message::ToolResult { usage, .. } => {
                        tool_results += 1;
                        if let Some(usage) = usage {
                            input += usage.input;
                            output_tokens += usage.output;
                            cache_read += usage.cache_read;
                            cache_write += usage.cache_write;
                            cost += usage.cost.total;
                        }
                    }
                }
            }
            let manager = app.session.session_manager.lock().await;
            Ok(Some(
                json!({"sessionFile":manager.file(),"sessionId":manager.header().id,"userMessages":users,"assistantMessages":assistants,"toolCalls":tool_calls,"toolResults":tool_results,"totalMessages":messages.len(),"tokens":{"input":input,"output":output_tokens,"cacheRead":cache_read,"cacheWrite":cache_write,"total":input+output_tokens+cache_read+cache_write},"cost":cost,"contextUsage":{"tokens":pi_ai::estimate_tokens(&messages),"contextWindow":app.session.model().context_window}}),
            ))
        }
        "bash" => {
            let command_text = required(command, "command")?;
            let output = tokio::process::Command::new(if cfg!(windows) { "powershell" } else { "bash" })
                .args(if cfg!(windows) {
                    vec!["-NoProfile", "-NonInteractive", "-Command", command_text]
                } else {
                    vec!["-lc", command_text]
                })
                .current_dir(app.session.cwd())
                .output()
                .await
                .map_err(|error| error.to_string())?;
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            let context_message = Message::user(format!("Ran `{command_text}`\n```\n{text}\n```"));
            let mut messages = app.session.agent.state().messages();
            messages.push(context_message.clone());
            app.session.agent.state().set_messages(messages);
            app.session
                .session_manager
                .lock()
                .await
                .append_message(context_message)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Some(
                json!({"output":text,"exitCode":output.status.code(),"cancelled":false,"truncated":false}),
            ))
        }
        "get_last_assistant_text" => {
            let text = last_assistant_text(&app.session.messages());
            Ok(Some(
                json!({"text":if text.is_empty(){Value::Null}else{Value::String(text)}}),
            ))
        }
        "set_session_name" => {
            let name = required(command, "name")?.replace(['\r', '\n'], " ");
            app.session
                .session_manager
                .lock()
                .await
                .append_session_info(name)
                .await
                .map_err(|e| e.to_string())?;
            Ok(None)
        }
        "get_tree" => {
            let manager = app.session.session_manager.lock().await;
            let tree = manager
                .entries()
                .iter()
                .filter(|entry| {
                    entry.parent_id.is_none()
                        || entry
                            .parent_id
                            .as_deref()
                            .is_some_and(|parent| manager.get_entry(parent).is_none())
                })
                .map(|entry| tree_node(entry, manager.entries()))
                .collect::<Vec<_>>();
            Ok(Some(json!({"tree":tree,"leafId":manager.leaf_id()})))
        }
        "get_entries" => {
            let manager = app.session.session_manager.lock().await;
            let mut entries = manager.entries();
            if let Some(since) = command.get("since").and_then(Value::as_str) {
                let position = entries
                    .iter()
                    .position(|entry| entry.id == since)
                    .ok_or("unknown entry cursor")?;
                entries = &entries[position + 1..];
            }
            Ok(Some(json!({"entries":entries,"leafId":manager.leaf_id()})))
        }
        "get_fork_messages" => {
            let manager = app.session.session_manager.lock().await;
            let messages = manager
                .entries()
                .iter()
                .filter_map(|entry| match &entry.data {
                    pi_agent_core::SessionEntryData::Message {
                        message: Message::User { content, .. },
                    } => Some(json!({"entryId":entry.id,"text":format!("{content:?}")})),
                    _ => None,
                })
                .collect::<Vec<_>>();
            Ok(Some(json!({"messages":messages})))
        }
        "get_commands" => {
            let extensions=app.extensions.commands().into_iter().map(|(name,(description,_,path))|json!({"name":name,"description":description,"source":"extension","path":path}));
            let prompts=app.session.resources.prompts.iter().map(|prompt|json!({"name":prompt.name,"description":prompt.description,"source":"prompt","path":prompt.path}));
            let skills=app.session.resources.skills.iter().map(|skill|json!({"name":format!("skill:{}",skill.name),"description":skill.description,"source":"skill","path":skill.path}));
            Ok(Some(
                json!({"commands":extensions.chain(prompts).chain(skills).collect::<Vec<_>>()}),
            ))
        }
        _ => Err(format!("Unknown command: {kind}")),
    }
}

pub async fn run_interactive(app: &App, initial: &[String]) -> Result<()> {
    println!(
        "pi {} — {}/{}",
        env!("CARGO_PKG_VERSION"),
        app.session.model().provider,
        app.session.model().id
    );
    for file in &app.session.resources.context_files {
        println!("Loaded {}", file.path.display())
    }
    let mut receiver = app.session.subscribe();
    let printer = tokio::spawn(async move {
        while let Ok(event) = receiver.recv().await {
            match event {
                AgentEvent::MessageUpdate {
                    assistant_message_event: AssistantMessageEvent::TextDelta { delta, .. },
                    ..
                } => {
                    print!("{delta}");
                    let _ = std::io::stdout().flush();
                }
                AgentEvent::ToolExecutionStart { tool_name, .. } => println!("\n[tool: {tool_name}]"),
                AgentEvent::ToolExecutionEnd { is_error, .. } if is_error => println!("[tool failed]"),
                AgentEvent::AgentEnd { .. } => {
                    println!();
                    print!("> ");
                    let _ = std::io::stdout().flush();
                }
                _ => {}
            }
        }
    });
    for message in initial {
        app.session.prompt(message, None).await?
    }
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    print!("> ");
    std::io::stdout().flush()?;
    while let Some(line) = lines.next_line().await? {
        let text = line.trim();
        if matches!(text, "/quit" | "/exit") {
            break;
        }
        if text == "/new" {
            app.session.new_session(&app.session_root, true).await?;
            println!("Started a new session.");
        } else if let Some(name) = text.strip_prefix("/name ") {
            app.session
                .session_manager
                .lock()
                .await
                .append_session_info(name.replace(['\r', '\n'], " "))
                .await?;
        } else if let Some(rest) = text.strip_prefix("/model ") {
            match app.model_runtime.resolve(None, rest) {
                Ok(model) => app.session.set_model(model).await?,
                Err(error) => eprintln!("{error}"),
            }
        } else if let Some(rest) = text.strip_prefix("/thinking ") {
            if let Some(level) = parse_thinking(rest) {
                app.session.set_thinking_level(level).await?
            }
        } else if text.starts_with("/compact") {
            let instructions = text.strip_prefix("/compact").map(str::trim).filter(|x| !x.is_empty());
            match app.session.compact(instructions).await {
                Ok(_) => println!("Compacted."),
                Err(error) => eprintln!("{error}"),
            }
        } else if let Some(command) = text.strip_prefix('/') {
            let (name, args) = command.split_once(' ').unwrap_or((command, ""));
            if let Some((_, executable, base)) = app.extensions.commands().get(name) {
                match crate::run_command(executable, base, args).await {
                    Ok(value) => println!("{value}"),
                    Err(error) => eprintln!("{error}"),
                }
            } else {
                app.session.prompt(text, None).await?
            }
        } else if !text.is_empty() {
            app.session.prompt(text, None).await?
        }
        print!("> ");
        std::io::stdout().flush()?;
    }
    app.session.abort();
    printer.abort();
    Ok(())
}

fn tree_node(entry: &pi_agent_core::SessionEntry, entries: &[pi_agent_core::SessionEntry]) -> Value {
    json!({"entry":entry,"children":entries.iter().filter(|child|child.parent_id.as_deref()==Some(&entry.id)).map(|child|tree_node(child,entries)).collect::<Vec<_>>()})
}
fn message_text(message: &Message) -> String {
    match message {
        Message::User {
            content: pi_ai::UserContent::Text(text),
            ..
        } => text.clone(),
        Message::User {
            content: pi_ai::UserContent::Blocks(blocks),
            ..
        } => pi_ai::content_text(blocks),
        _ => String::new(),
    }
}
fn queue_mode_text(mode: pi_agent_core::QueueMode) -> &'static str {
    match mode {
        pi_agent_core::QueueMode::All => "all",
        pi_agent_core::QueueMode::OneAtATime => "one-at-a-time",
    }
}
fn parse_queue_mode(value: &str) -> Result<pi_agent_core::QueueMode, String> {
    match value {
        "all" => Ok(pi_agent_core::QueueMode::All),
        "one-at-a-time" => Ok(pi_agent_core::QueueMode::OneAtATime),
        _ => Err("invalid queue mode".into()),
    }
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field: {name}"))
}
fn response(id: Option<Value>, command: &str, success: bool, data: Option<Value>, error: Option<String>) -> Value {
    let mut value = json!({"type":"response","command":command,"success":success});
    if let Some(id) = id {
        value["id"] = id
    }
    if let Some(data) = data {
        value["data"] = data
    }
    if let Some(error) = error {
        value["error"] = json!(error)
    }
    value
}
async fn write_json(output: &Output, value: &Value) -> Result<()> {
    let mut output = output.lock().await;
    output.write_all(serde_json::to_string(value)?.as_bytes()).await?;
    output.write_all(b"\n").await?;
    output.flush().await?;
    Ok(())
}
fn agent_event_json(event: AgentEvent) -> Value {
    if let AgentEvent::MessageUpdate {
        message,
        assistant_message_event,
    } = event
    {
        let mut update = camelize(serde_json::to_value(assistant_message_event).unwrap_or(Value::Null));
        if let Some(object) = update.as_object_mut() {
            object.remove("partial");
        }
        return json!({"type":"message_update","usage":message.usage,"assistantMessageEvent":update});
    }
    camelize(serde_json::to_value(event).unwrap_or(Value::Null))
}
fn camelize(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (snake_to_camel(&key), camelize(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(camelize).collect()),
        value => value,
    }
}
fn snake_to_camel(value: &str) -> String {
    let mut output = String::new();
    let mut upper = false;
    for character in value.chars() {
        if character == '_' {
            upper = true
        } else if upper {
            output.extend(character.to_uppercase());
            upper = false
        } else {
            output.push(character)
        }
    }
    output
}
