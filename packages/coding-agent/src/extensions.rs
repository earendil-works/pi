use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use async_trait::async_trait;
use pi_agent_core::{AfterToolDecision, AgentError, AgentHooks, AgentTool, AgentToolResult, BeforeToolDecision};
use pi_ai::{AssistantMessage, Content, Context, Message};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, process::Command};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub name: String,
    #[serde(default)]
    pub commands: HashMap<String, ExtensionCommand>,
    #[serde(default)]
    pub tools: Vec<ExtensionToolDefinition>,
    #[serde(default)]
    pub hooks: HashMap<String, Executable>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Executable {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct ExtensionCommand {
    pub description: String,
    #[serde(flatten)]
    pub executable: Executable,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionToolDefinition {
    pub name: String,
    pub label: String,
    pub description: String,
    pub parameters: Value,
    #[serde(flatten)]
    pub executable: Executable,
}
#[derive(Clone, Debug, Default)]
pub struct ExtensionLoadResult {
    pub extensions: Vec<LoadedExtension>,
    pub errors: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct LoadedExtension {
    pub path: PathBuf,
    pub manifest: ExtensionManifest,
}

impl ExtensionLoadResult {
    pub async fn load(paths: &[PathBuf]) -> Self {
        let mut result = Self::default();
        for path in paths {
            match tokio::fs::read(path)
                .await
                .ok()
                .and_then(|data| serde_json::from_slice::<ExtensionManifest>(&data).ok())
            {
                Some(manifest) => result.extensions.push(LoadedExtension {
                    path: path.clone(),
                    manifest,
                }),
                None => result
                    .errors
                    .push(format!("invalid Rust extension manifest: {}", path.display())),
            }
        }
        result
    }
    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn AgentTool>> {
        self.extensions
            .iter()
            .flat_map(|extension| {
                extension.manifest.tools.iter().cloned().map(move |definition| {
                    Arc::new(ExtensionTool {
                        definition,
                        base: extension.path.parent().unwrap_or(Path::new(".")).to_owned(),
                    }) as Arc<dyn AgentTool>
                })
            })
            .collect()
    }
    #[must_use]
    pub fn commands(&self) -> HashMap<String, (String, Executable, PathBuf)> {
        let mut result = HashMap::new();
        for extension in &self.extensions {
            for (name, command) in &extension.manifest.commands {
                result.insert(
                    name.clone(),
                    (
                        command.description.clone(),
                        command.executable.clone(),
                        extension.path.parent().unwrap_or(Path::new(".")).to_owned(),
                    ),
                );
            }
        }
        result
    }
    pub async fn emit(&self, event: &str, payload: &Value) {
        let _ = self.call_hooks(event, payload, CancellationToken::new()).await;
    }
    pub async fn call_hooks(&self, event: &str, payload: &Value, cancellation: CancellationToken) -> Vec<Value> {
        let mut responses = Vec::new();
        for extension in &self.extensions {
            if let Some(executable) = extension.manifest.hooks.get(event) {
                if let Ok(value) = run_executable(
                    executable,
                    extension.path.parent().unwrap_or(Path::new(".")),
                    &json!({"event":event,"payload":payload}),
                    cancellation.clone(),
                )
                .await
                {
                    responses.push(value);
                }
            }
        }
        responses
    }
}

pub struct NativeExtensionHooks {
    extensions: Arc<ExtensionLoadResult>,
}
impl NativeExtensionHooks {
    #[must_use]
    pub fn new(extensions: Arc<ExtensionLoadResult>) -> Self {
        Self { extensions }
    }
}
#[async_trait]
impl AgentHooks for NativeExtensionHooks {
    async fn transform_context(&self, mut messages: Vec<Message>, cancellation: CancellationToken) -> Vec<Message> {
        for response in self
            .extensions
            .call_hooks("context", &json!({"messages":messages}), cancellation)
            .await
        {
            if let Some(value) = response.get("messages")
                && let Ok(replacement) = serde_json::from_value(value.clone())
            {
                messages = replacement;
            }
        }
        messages
    }
    async fn before_tool_call(
        &self,
        assistant: &AssistantMessage,
        call: &Content,
        args: &Value,
        context: &Context,
        cancellation: CancellationToken,
    ) -> BeforeToolDecision {
        let mut decision = BeforeToolDecision::default();
        for response in self
            .extensions
            .call_hooks(
                "tool_call",
                &json!({"assistant":assistant,"call":call,"input":args,"context":context}),
                cancellation,
            )
            .await
        {
            if response.get("block").and_then(Value::as_bool).unwrap_or(false) {
                decision.block = true;
                decision.reason = response.get("reason").and_then(Value::as_str).map(str::to_owned);
                decision.terminate = response.get("terminate").and_then(Value::as_bool).unwrap_or(false);
                break;
            }
        }
        decision
    }
    async fn after_tool_call(
        &self,
        assistant: &AssistantMessage,
        call: &Content,
        args: &Value,
        context: &Context,
        result: &AgentToolResult,
        is_error: bool,
        cancellation: CancellationToken,
    ) -> AfterToolDecision {
        let mut patch = AfterToolDecision::default();
        for response in self.extensions.call_hooks("tool_result", &json!({"assistant":assistant,"call":call,"input":args,"context":context,"result":result,"isError":is_error}), cancellation.clone()).await {
            if let Some(value)=response.get("content") { patch.content=serde_json::from_value(value.clone()).ok(); }
            if let Some(value)=response.get("details") { patch.details=Some(value.clone()); }
            if let Some(value)=response.get("usage") { patch.usage=serde_json::from_value(value.clone()).ok(); }
            if let Some(value)=response.get("isError").and_then(Value::as_bool) { patch.is_error=Some(value); }
            if let Some(value)=response.get("terminate").and_then(Value::as_bool) { patch.terminate=Some(value); }
        }
        patch
    }
    async fn should_stop_after_turn(
        &self,
        assistant: &AssistantMessage,
        tool_results: &[Message],
        context: &Context,
        cancellation: CancellationToken,
    ) -> bool {
        self.extensions
            .call_hooks(
                "turn_end",
                &json!({"message":assistant,"toolResults":tool_results,"context":context}),
                cancellation,
            )
            .await
            .iter()
            .any(|response| response.get("stop").and_then(Value::as_bool).unwrap_or(false))
    }
}

struct ExtensionTool {
    definition: ExtensionToolDefinition,
    base: PathBuf,
}
#[async_trait]
impl AgentTool for ExtensionTool {
    fn name(&self) -> &str {
        &self.definition.name
    }
    fn label(&self) -> &str {
        &self.definition.label
    }
    fn description(&self) -> &str {
        &self.definition.description
    }
    fn parameters(&self) -> Value {
        self.definition.parameters.clone()
    }
    async fn execute(
        &self,
        call_id: &str,
        parameters: Value,
        cancellation: CancellationToken,
    ) -> Result<AgentToolResult, AgentError> {
        let payload =
            json!({"type":"tool_call","toolCallId":call_id,"name":self.definition.name,"parameters":parameters});
        let value = run_executable(&self.definition.executable, &self.base, &payload, cancellation)
            .await
            .map_err(|message| AgentError::Tool {
                tool: self.definition.name.clone(),
                message,
            })?;
        serde_json::from_value(value).map_err(|error| AgentError::Tool {
            tool: self.definition.name.clone(),
            message: error.to_string(),
        })
    }
}

pub async fn run_command(executable: &Executable, base: &Path, args: &str) -> Result<Value, String> {
    run_executable(
        executable,
        base,
        &json!({"type":"command","args":args}),
        CancellationToken::new(),
    )
    .await
}
async fn run_executable(
    executable: &Executable,
    base: &Path,
    payload: &Value,
    cancellation: CancellationToken,
) -> Result<Value, String> {
    let base = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned());
    let command_path = Path::new(&executable.command);
    let program = if command_path.is_absolute() || command_path.components().count() == 1 {
        PathBuf::from(&executable.command)
    } else {
        base.join(command_path)
    };
    let mut child = Command::new(program);
    child
        .args(&executable.args)
        .current_dir(&base)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = child.spawn().map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or("extension stdin unavailable")?;
    stdin
        .write_all(
            serde_json::to_string(payload)
                .map_err(|error| error.to_string())?
                .as_bytes(),
        )
        .await
        .map_err(|error| error.to_string())?;
    drop(stdin);
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    let output = tokio::select! {result=&mut wait=>result.map_err(|error|error.to_string())?,()=cancellation.cancelled()=>return Err("extension cancelled".into())};
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    if output.stdout.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("extension returned invalid JSON: {error}"))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtensionProtocolVersion {
    pub version: u32,
}
pub const EXTENSION_PROTOCOL_VERSION: u32 = 1;
