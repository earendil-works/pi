use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use base64::Engine;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyModifiers};
use futures::StreamExt;
use parking_lot::Mutex;
use pi_agent_core::AgentEvent;
use pi_ai::{AssistantMessageEvent, Content, Message};
use pi_tui::{
    Component, ProcessTerminal, SharedComponent, Tui, TuiAltScreen, TuiMainScreen, truncate_to_width,
    wrap_text_with_ansi,
};
use tokio::task::JoinSet;

use crate::{App, parse_thinking};

struct InteractiveView {
    transcript: Vec<String>,
    streaming: String,
    input: String,
    status: String,
}

impl InteractiveView {
    fn new(app: &App) -> Self {
        let mut transcript = Vec::new();
        transcript.push(format!(
            "pi {} — {}/{}",
            env!("CARGO_PKG_VERSION"),
            app.session.model().provider,
            app.session.model().id
        ));
        for message in app.session.messages() {
            match message {
                Message::User { content, .. } => transcript.push(format!("> {content:?}")),
                Message::Assistant { message } if !message.text().is_empty() => transcript.push(message.text()),
                _ => {}
            }
        }
        Self {
            transcript,
            streaming: String::new(),
            input: String::new(),
            status: "ready".into(),
        }
    }

    fn submit(&mut self) -> Option<String> {
        let text = self.input.trim().to_owned();
        self.input.clear();
        if text.is_empty() {
            None
        } else {
            self.transcript.push(format!("> {text}"));
            Some(text)
        }
    }
}

impl Component for InteractiveView {
    fn render(&mut self, width: usize) -> Vec<String> {
        let mut lines = Vec::new();
        for item in &self.transcript {
            lines.extend(wrap_text_with_ansi(item, width));
            lines.push(String::new());
        }
        if !self.streaming.is_empty() {
            lines.extend(wrap_text_with_ansi(&self.streaming, width));
            lines.push(String::new());
        }
        lines.push(truncate_to_width(&format!("[{}]", self.status), width, "..."));
        let input = self.input.replace('\n', "↵");
        lines.push(truncate_to_width(&format!("> {input}\x1b[7m \x1b[27m"), width, ""));
        lines
    }
}

pub async fn run_native_interactive(app: Arc<App>, initial: &[String]) -> Result<()> {
    let view = Arc::new(Mutex::new(InteractiveView::new(&app)));
    let root: SharedComponent = view.clone();
    let fullscreen = app.settings.tui_mode == "fullscreen";
    let mut tui: Box<dyn Tui> = if fullscreen {
        let mut renderer = TuiAltScreen::new(ProcessTerminal::new());
        renderer.set_layout_root(root);
        Box::new(renderer)
    } else {
        let mut renderer = TuiMainScreen::new(ProcessTerminal::new());
        renderer.add_child(root);
        Box::new(renderer)
    };
    tui.start()?;
    let mut events = EventStream::new();
    let mut agent_events = app.session.subscribe();
    let mut prompts = JoinSet::new();
    for message in initial {
        let session = app.session.clone();
        let message = message.clone();
        prompts.spawn(async move { session.prompt(&message, None).await.map_err(anyhow::Error::from) });
    }
    let mut last_ctrl_c: Option<Instant> = None;
    loop {
        tokio::select! {
            terminal = events.next() => {
                let Some(Ok(event)) = terminal else { break };
                if let Event::Key(key) = event {
                    if handle_key(&app, &view, key, &mut prompts, &mut last_ctrl_c).await? { break; }
                    tui.request_render()?;
                }
            }
            event = agent_events.recv() => {
                match event {
                    Ok(event) => apply_agent_event(&view, event),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => view.lock().status = format!("event stream lagged by {count}"),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
                tui.request_render()?;
            }
            completed = prompts.join_next(), if !prompts.is_empty() => {
                if let Some(Ok(Err(error))) = completed { view.lock().transcript.push(format!("Error: {error}")); }
                tui.request_render()?;
            }
        }
    }
    app.session.abort();
    prompts.abort_all();
    tui.stop()?;
    Ok(())
}

async fn handle_key(
    app: &Arc<App>,
    view: &Arc<Mutex<InteractiveView>>,
    key: KeyEvent,
    prompts: &mut JoinSet<Result<()>>,
    last_ctrl_c: &mut Option<Instant>,
) -> Result<bool> {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        if view.lock().input.is_empty() {
            let now = Instant::now();
            if last_ctrl_c.is_some_and(|last| now.duration_since(last) < Duration::from_millis(700)) {
                return Ok(true);
            }
            *last_ctrl_c = Some(now);
            view.lock().status = "press Ctrl+C again to quit".into();
        } else {
            view.lock().input.clear();
        }
        return Ok(false);
    }
    *last_ctrl_c = None;
    match key.code {
        KeyCode::Esc => {
            app.session.abort();
            view.lock().status = "aborting".into();
        }
        KeyCode::Backspace => {
            view.lock().input.pop();
        }
        KeyCode::Enter if key.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) => {
            view.lock().input.push('\n')
        }
        KeyCode::Enter => {
            let submitted = { view.lock().submit() };
            if let Some(text) = submitted {
                if run_builtin(app, view, &text).await? {
                    return Ok(true);
                }
                if !text.starts_with('/') || is_resource_command(app, &text) {
                    let session = app.session.clone();
                    let behavior = session.is_streaming().then_some("steer");
                    prompts.spawn(async move { session.prompt(&text, behavior).await.map_err(anyhow::Error::from) });
                }
            }
        }
        KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => view.lock().input.push(character),
        KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) && view.lock().input.is_empty() => {
            return Ok(true);
        }
        _ => {}
    }
    Ok(false)
}

fn is_resource_command(app: &App, text: &str) -> bool {
    let name = text
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or_default();
    name.starts_with("skill:") || app.session.resources.prompts.iter().any(|prompt| prompt.name == name)
}

async fn run_builtin(app: &Arc<App>, view: &Arc<Mutex<InteractiveView>>, text: &str) -> Result<bool> {
    if matches!(text, "/quit" | "/exit") {
        return Ok(true);
    }
    if text == "/new" {
        app.session.new_session(&app.session_root, true).await?;
        view.lock().transcript.clear();
    } else if let Some(name) = text.strip_prefix("/name ") {
        app.session
            .session_manager
            .lock()
            .await
            .append_session_info(name.replace(['\r', '\n'], " "))
            .await?;
    } else if let Some(pattern) = text.strip_prefix("/model ") {
        match app.model_runtime.resolve(None, pattern) {
            Ok(model) => {
                app.session.set_model(model).await?;
                view.lock().status = format!("model: {pattern}");
            }
            Err(error) => view.lock().transcript.push(format!("Error: {error}")),
        }
    } else if let Some(value) = text.strip_prefix("/thinking ") {
        if let Some(level) = parse_thinking(value) {
            app.session.set_thinking_level(level).await?;
        }
    } else if text.starts_with("/compact") {
        let instructions = text
            .strip_prefix("/compact")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        app.session.compact(instructions).await?;
    } else if text == "/tree" {
        let manager = app.session.session_manager.lock().await;
        for entry in manager.active_path() {
            view.lock().transcript.push(format!(
                "{} <- {}: {:?}",
                entry.id,
                entry.parent_id.as_deref().unwrap_or("root"),
                entry.data
            ));
        }
    } else if let Some(path) = text.strip_prefix("/resume ") {
        app.session.switch_session(std::path::Path::new(path)).await?;
        view.lock().transcript.push(format!("Resumed {path}"));
    } else if let Some(id) = text.strip_prefix("/fork ") {
        app.session.fork_session(id, &app.session_root).await?;
        view.lock().transcript.push(format!("Forked at {id}"));
    } else if text == "/clone" {
        let leaf = app.session.session_manager.lock().await.leaf_id().map(str::to_owned);
        if let Some(leaf) = leaf {
            app.session.fork_session(&leaf, &app.session_root).await?;
        }
    } else if let Some(path) = text.strip_prefix("/export").map(str::trim) {
        let manager = app.session.session_manager.lock().await;
        if let Some(input) = manager.file().map(std::path::Path::to_owned) {
            drop(manager);
            let output = (!path.is_empty()).then(|| std::path::Path::new(path));
            let exported = crate::export_session_html(&input, output).await?;
            view.lock().transcript.push(format!("Exported {}", exported.display()));
        }
    } else if text == "/share" {
        let file = app
            .session
            .session_manager
            .lock()
            .await
            .file()
            .map(std::path::Path::to_owned);
        if let Some(file) = file {
            let output = tokio::process::Command::new("gh")
                .args(["gist", "create", "--private"])
                .arg(file)
                .output()
                .await?;
            let result = if output.status.success() {
                String::from_utf8_lossy(&output.stdout).into_owned()
            } else {
                format!("Share failed: {}", String::from_utf8_lossy(&output.stderr))
            };
            view.lock().transcript.push(result);
        }
    } else if text == "/copy" {
        let content = crate::last_assistant_text(&app.session.messages());
        let encoded = base64::engine::general_purpose::STANDARD.encode(content);
        print!("\x1b]52;c;{encoded}\x07");
    } else if text == "/hotkeys" {
        view.lock()
            .transcript
            .push("Enter submit · Shift/Alt+Enter newline · Escape abort · Ctrl+C twice quit".into());
    } else if text == "/trust" {
        crate::save_trust(app.session.cwd(), &app.agent_dir, true).await?;
        view.lock()
            .transcript
            .push("Project trust saved; restart to reload project resources.".into());
    } else if text == "/session" {
        let manager = app.session.session_manager.lock().await;
        view.lock().transcript.push(format!(
            "Session {}\nFile: {}\nMessages: {}",
            manager.header().id,
            manager
                .file()
                .map_or_else(|| "ephemeral".into(), |path| path.display().to_string()),
            app.session.messages().len()
        ));
    } else if text.starts_with('/') && !is_resource_command(app, text) {
        let command = text.trim_start_matches('/');
        let (name, args) = command.split_once(' ').unwrap_or((command, ""));
        if let Some((_, executable, base)) = app.extensions.commands().get(name) {
            match crate::run_command(executable, base, args).await {
                Ok(value) => view.lock().transcript.push(value.to_string()),
                Err(error) => view.lock().transcript.push(format!("Error: {error}")),
            }
        } else {
            view.lock().transcript.push(format!("Unknown command: /{name}"));
        }
    } else {
        return Ok(false);
    }
    Ok(false)
}

fn apply_agent_event(view: &Arc<Mutex<InteractiveView>>, event: AgentEvent) {
    let mut view = view.lock();
    match event {
        AgentEvent::AgentStart => view.status = "working".into(),
        AgentEvent::AgentEnd { .. } => {
            if !view.streaming.is_empty() {
                let completed = std::mem::take(&mut view.streaming);
                view.transcript.push(completed);
            }
            view.status = "ready".into();
        }
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::TextDelta { delta, .. },
            ..
        } => view.streaming.push_str(&delta),
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::ThinkingDelta { delta, .. },
            ..
        } => view.streaming.push_str(&format!("\x1b[2m{delta}\x1b[0m")),
        AgentEvent::ToolExecutionStart { tool_name, .. } => view.transcript.push(format!("[tool: {tool_name}]")),
        AgentEvent::ToolExecutionEnd { result, is_error, .. } => {
            let text = result
                .content
                .iter()
                .filter_map(|block| match block {
                    Content::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            view.transcript
                .push(format!("{}{}", if is_error { "Error: " } else { "" }, text));
        }
        _ => {}
    }
}
