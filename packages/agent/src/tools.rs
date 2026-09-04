use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use base64::Engine;
use ignore::WalkBuilder;
use pi_ai::Content;
use regex::Regex;
use serde_json::{Value, json};
use tokio::{fs, process::Command};
use tokio_util::sync::CancellationToken;

use crate::{AgentError, AgentTool, AgentToolResult, ToolExecutionMode};

const MAX_OUTPUT_BYTES: usize = 50 * 1024;
const MAX_OUTPUT_LINES: usize = 2_000;

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    }
}

fn required_string<'a>(parameters: &'a Value, name: &str, tool: &str) -> Result<&'a str, AgentError> {
    parameters
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| AgentError::Tool {
            tool: tool.into(),
            message: format!("missing string parameter: {name}"),
        })
}

fn truncate_tail(text: &str) -> String {
    if text.len() <= MAX_OUTPUT_BYTES && text.lines().count() <= MAX_OUTPUT_LINES {
        return text.to_owned();
    }
    let mut lines = text.lines().rev().take(MAX_OUTPUT_LINES).collect::<Vec<_>>();
    lines.reverse();
    let mut output = lines.join("\n");
    if output.len() > MAX_OUTPUT_BYTES {
        let mut remove = output.len() - MAX_OUTPUT_BYTES;
        while !output.is_char_boundary(remove) {
            remove += 1;
        }
        output.drain(..remove);
    }
    format!("[output truncated; showing final 2000 lines or 50 KiB]\n{output}")
}

fn truncate_output(text: &str) -> String {
    let mut output = String::new();
    let mut bytes = 0;
    let mut lines = 0;
    let mut omitted = false;
    for line in text.split_inclusive('\n') {
        if lines >= MAX_OUTPUT_LINES || bytes + line.len() > MAX_OUTPUT_BYTES {
            omitted = true;
            break;
        }
        output.push_str(line);
        bytes += line.len();
        lines += 1;
    }
    if omitted {
        output.push_str("\n[output truncated at 2000 lines or 50 KiB]\n");
    }
    output
}

#[derive(Clone)]
pub struct ReadTool {
    cwd: PathBuf,
}

impl ReadTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}

#[async_trait]
impl AgentTool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }
    fn label(&self) -> &str {
        "Read"
    }
    fn description(&self) -> &str {
        "Read a text file with optional 1-indexed line offset and line limit, or return a supported image."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false})
    }
    async fn execute(
        &self,
        _call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError> {
        let path = resolve(&self.cwd, required_string(&parameters, "path", self.name())?);
        let data = tokio::select! {
            result = fs::read(&path) => result.map_err(|error| AgentError::Tool { tool:self.name().into(), message:error.to_string() })?,
            () = cancellation.cancelled() => return Err(AgentError::Aborted),
        };
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "bmp" => Some("image/bmp"),
            _ => None,
        };
        if let Some(mime_type) = mime {
            return Ok(AgentToolResult {
                content: vec![Content::Image {
                    data: base64::engine::general_purpose::STANDARD.encode(&data),
                    mime_type: mime_type.into(),
                }],
                details: json!({"path":path,"bytes":data.len()}),
                usage: None,
                added_tool_names: Vec::new(),
                terminate: false,
            });
        }
        let text = String::from_utf8(data).map_err(|_| AgentError::Tool {
            tool: self.name().into(),
            message: "file is not valid UTF-8".into(),
        })?;
        let offset = parameters.get("offset").and_then(Value::as_u64).unwrap_or(1) as usize;
        let limit = parameters
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(MAX_OUTPUT_LINES as u64) as usize;
        let selected = text
            .lines()
            .skip(offset.saturating_sub(1))
            .take(limit)
            .collect::<Vec<_>>()
            .join("\n");
        Ok(AgentToolResult {
            content: vec![Content::text(truncate_output(&selected))],
            details: json!({"path":path,"offset":offset,"limit":limit}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[derive(Clone)]
pub struct WriteTool {
    cwd: PathBuf,
}
impl WriteTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
#[async_trait]
impl AgentTool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }
    fn label(&self) -> &str {
        "Write"
    }
    fn description(&self) -> &str {
        "Create or overwrite a UTF-8 file and create its parent directories."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false})
    }
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        Some(ToolExecutionMode::Sequential)
    }
    async fn execute(
        &self,
        _call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError> {
        let path = resolve(&self.cwd, required_string(&parameters, "path", self.name())?);
        let content = required_string(&parameters, "content", self.name())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| AgentError::Tool {
                tool: self.name().into(),
                message: e.to_string(),
            })?;
        }
        tokio::select! { result=fs::write(&path,content)=>result.map_err(|e|AgentError::Tool{tool:self.name().into(),message:e.to_string()})?, ()=cancellation.cancelled()=>return Err(AgentError::Aborted) }
        Ok(AgentToolResult {
            content: vec![Content::text(format!(
                "Wrote {} bytes to {}",
                content.len(),
                path.display()
            ))],
            details: json!({"path":path,"bytes":content.len()}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[derive(Clone)]
pub struct EditTool {
    cwd: PathBuf,
}
impl EditTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
#[async_trait]
impl AgentTool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }
    fn label(&self) -> &str {
        "Edit"
    }
    fn description(&self) -> &str {
        "Apply one or more unique, non-overlapping exact text replacements to a UTF-8 file."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"},"edits":{"type":"array","minItems":1,"items":{"type":"object","properties":{"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["oldText","newText"],"additionalProperties":false}},"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["path"],"anyOf":[{"required":["edits"]},{"required":["oldText","newText"]}],"additionalProperties":false})
    }
    fn execution_mode(&self) -> Option<ToolExecutionMode> {
        Some(ToolExecutionMode::Sequential)
    }
    async fn execute(
        &self,
        _: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError> {
        let path = resolve(&self.cwd, required_string(&parameters, "path", self.name())?);
        let replacements = if let Some(edits) = parameters.get("edits").and_then(Value::as_array) {
            edits
                .iter()
                .map(|edit| {
                    Ok((
                        required_string(edit, "oldText", self.name())?.to_owned(),
                        required_string(edit, "newText", self.name())?.to_owned(),
                    ))
                })
                .collect::<Result<Vec<_>, AgentError>>()?
        } else {
            vec![(
                required_string(&parameters, "oldText", self.name())?.to_owned(),
                required_string(&parameters, "newText", self.name())?.to_owned(),
            )]
        };
        let before = tokio::select! {result=fs::read_to_string(&path)=>result.map_err(|e|AgentError::Tool{tool:self.name().into(),message:e.to_string()})?,()=cancellation.cancelled()=>return Err(AgentError::Aborted)};
        let mut located = Vec::new();
        for (old, new) in replacements {
            let positions = before
                .match_indices(&old)
                .map(|(position, _)| position)
                .collect::<Vec<_>>();
            if positions.len() != 1 {
                return Err(AgentError::Tool {
                    tool: self.name().into(),
                    message: format!("oldText must match exactly once; found {}", positions.len()),
                });
            }
            located.push((positions[0], positions[0] + old.len(), new));
        }
        located.sort_by_key(|(start, ..)| *start);
        if located.windows(2).any(|pair| pair[0].1 > pair[1].0) {
            return Err(AgentError::Tool {
                tool: self.name().into(),
                message: "edit blocks overlap".into(),
            });
        }
        let mut after = before.clone();
        for (start, end, new) in located.into_iter().rev() {
            after.replace_range(start..end, &new);
        }
        fs::write(&path, &after).await.map_err(|e| AgentError::Tool {
            tool: self.name().into(),
            message: e.to_string(),
        })?;
        Ok(AgentToolResult {
            content: vec![Content::text(format!("Updated {}", path.display()))],
            details: json!({"path":path,"beforeBytes":before.len(),"afterBytes":after.len()}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[derive(Clone)]
pub struct BashTool {
    cwd: PathBuf,
    timeout: Duration,
}
impl BashTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            cwd: cwd.into(),
            timeout: Duration::from_secs(300),
        }
    }
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }
}
#[async_trait]
impl AgentTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn label(&self) -> &str {
        "Bash"
    }
    fn description(&self) -> &str {
        "Execute a non-interactive shell command in the working directory."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer","minimum":1}},"required":["command"],"additionalProperties":false})
    }
    async fn execute(
        &self,
        _: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError> {
        let command = required_string(&parameters, "command", self.name())?;
        let timeout = parameters
            .get("timeout")
            .and_then(Value::as_u64)
            .map(Duration::from_secs)
            .unwrap_or(self.timeout);
        let mut child = Command::new(if cfg!(windows) { "powershell" } else { "bash" });
        if cfg!(windows) {
            child.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        } else {
            child.args(["-lc", command]);
        }
        child
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = child.spawn().map_err(|e| AgentError::Tool {
            tool: self.name().into(),
            message: e.to_string(),
        })?;
        let output_future = child.wait_with_output();
        tokio::pin!(output_future);
        let output = tokio::select! {result=&mut output_future=>result.map_err(|e|AgentError::Tool{tool:self.name().into(),message:e.to_string()})?,()=cancellation.cancelled()=>return Err(AgentError::Aborted),()=tokio::time::sleep(timeout)=>return Err(AgentError::Tool{tool:self.name().into(),message:format!("command timed out after {}s",timeout.as_secs())})};
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        let text = truncate_tail(&text);
        let code = output.status.code().unwrap_or(-1);
        if !output.status.success() {
            return Err(AgentError::Tool {
                tool: self.name().into(),
                message: format!("command exited with code {code}\n{text}"),
            });
        }
        Ok(AgentToolResult {
            content: vec![Content::text(text)],
            details: json!({"exitCode":code}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }

    async fn execute_with_updates(
        &self,
        call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
        on_update: Arc<dyn Fn(AgentToolResult) + Send + Sync>,
    ) -> Result<AgentToolResult, AgentError> {
        on_update(AgentToolResult {
            content: vec![Content::text("Command started")],
            details: json!({"running":true}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        });
        self.execute(call_id, parameters, cancellation).await
    }
}

#[derive(Clone)]
pub struct GrepTool {
    cwd: PathBuf,
}
impl GrepTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
#[async_trait]
impl AgentTool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    fn label(&self) -> &str {
        "Grep"
    }
    fn description(&self) -> &str {
        "Search file contents using a Rust regular expression, respecting ignore files."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"ignoreCase":{"type":"boolean"},"limit":{"type":"integer","minimum":1}},"required":["pattern"],"additionalProperties":false})
    }
    async fn execute(&self, _: &str, p: Value, c: CancellationToken) -> Result<AgentToolResult, AgentError> {
        let pattern = required_string(&p, "pattern", self.name())?;
        let pattern = if p.get("ignoreCase").and_then(Value::as_bool).unwrap_or(false) {
            format!("(?i){pattern}")
        } else {
            pattern.into()
        };
        let regex = Regex::new(&pattern).map_err(|e| AgentError::Tool {
            tool: self.name().into(),
            message: e.to_string(),
        })?;
        let root = resolve(&self.cwd, p.get("path").and_then(Value::as_str).unwrap_or("."));
        let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(1000) as usize;
        let mut matches = Vec::new();
        for entry in WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .build()
            .filter_map(Result::ok)
        {
            if c.is_cancelled() {
                return Err(AgentError::Aborted);
            }
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            for (line_no, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    matches.push(format!("{}:{}:{}", entry.path().display(), line_no + 1, line));
                    if matches.len() >= limit {
                        break;
                    }
                }
            }
            if matches.len() >= limit {
                break;
            }
        }
        Ok(AgentToolResult {
            content: vec![Content::text(truncate_output(&matches.join("\n")))],
            details: json!({"matches":matches.len()}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[derive(Clone)]
pub struct FindTool {
    cwd: PathBuf,
}
impl FindTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
#[async_trait]
impl AgentTool for FindTool {
    fn name(&self) -> &str {
        "find"
    }
    fn label(&self) -> &str {
        "Find"
    }
    fn description(&self) -> &str {
        "Find paths using a glob pattern, respecting ignore files."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"},"limit":{"type":"integer","minimum":1}},"required":["pattern"],"additionalProperties":false})
    }
    async fn execute(&self, _: &str, p: Value, c: CancellationToken) -> Result<AgentToolResult, AgentError> {
        let pattern = required_string(&p, "pattern", self.name())?;
        let glob = globset::Glob::new(pattern)
            .map_err(|e| AgentError::Tool {
                tool: self.name().into(),
                message: e.to_string(),
            })?
            .compile_matcher();
        let root = resolve(&self.cwd, p.get("path").and_then(Value::as_str).unwrap_or("."));
        let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(1000) as usize;
        let mut found = Vec::new();
        for entry in WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .build()
            .filter_map(Result::ok)
        {
            if c.is_cancelled() {
                return Err(AgentError::Aborted);
            }
            let relative = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            if glob.is_match(relative) || glob.is_match(entry.file_name()) {
                found.push(relative.display().to_string());
                if found.len() >= limit {
                    break;
                }
            }
        }
        Ok(AgentToolResult {
            content: vec![Content::text(found.join("\n"))],
            details: json!({"matches":found.len()}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[derive(Clone)]
pub struct LsTool {
    cwd: PathBuf,
}
impl LsTool {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
#[async_trait]
impl AgentTool for LsTool {
    fn name(&self) -> &str {
        "ls"
    }
    fn label(&self) -> &str {
        "List"
    }
    fn description(&self) -> &str {
        "List one directory."
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false})
    }
    async fn execute(&self, _: &str, p: Value, c: CancellationToken) -> Result<AgentToolResult, AgentError> {
        let path = resolve(&self.cwd, p.get("path").and_then(Value::as_str).unwrap_or("."));
        let mut reader = fs::read_dir(&path).await.map_err(|e| AgentError::Tool {
            tool: self.name().into(),
            message: e.to_string(),
        })?;
        let mut entries = Vec::new();
        while let Some(entry) = tokio::select! {result=reader.next_entry()=>result.map_err(|e|AgentError::Tool{tool:self.name().into(),message:e.to_string()})?,()=c.cancelled()=>return Err(AgentError::Aborted)}
        {
            let file_type = entry.file_type().await.map_err(|e| AgentError::Tool {
                tool: self.name().into(),
                message: e.to_string(),
            })?;
            entries.push(format!(
                "{}{}",
                entry.file_name().to_string_lossy(),
                if file_type.is_dir() { "/" } else { "" }
            ));
        }
        entries.sort();
        Ok(AgentToolResult {
            content: vec![Content::text(entries.join("\n"))],
            details: json!({"entries":entries.len()}),
            usage: None,
            added_tool_names: Vec::new(),
            terminate: false,
        })
    }
}

#[must_use]
pub fn create_coding_tools(cwd: impl Into<PathBuf>) -> Vec<Arc<dyn AgentTool>> {
    let cwd = cwd.into();
    vec![
        Arc::new(ReadTool::new(&cwd)),
        Arc::new(BashTool::new(&cwd)),
        Arc::new(EditTool::new(&cwd)),
        Arc::new(WriteTool::new(&cwd)),
        Arc::new(GrepTool::new(&cwd)),
        Arc::new(FindTool::new(&cwd)),
        Arc::new(LsTool::new(&cwd)),
    ]
}

#[must_use]
pub fn create_read_only_tools(cwd: impl Into<PathBuf>) -> Vec<Arc<dyn AgentTool>> {
    let cwd = cwd.into();
    vec![
        Arc::new(ReadTool::new(&cwd)),
        Arc::new(GrepTool::new(&cwd)),
        Arc::new(FindTool::new(&cwd)),
        Arc::new(LsTool::new(&cwd)),
    ]
}
