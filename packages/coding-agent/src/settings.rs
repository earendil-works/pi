use std::path::{Path, PathBuf};

use pi_ai::{ThinkingLevel, Transport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub default_thinking_level: ThinkingLevel,
    pub model_thinking_levels: std::collections::BTreeMap<String, ThinkingLevel>,
    pub hide_thinking_block: bool,
    pub theme: String,
    pub quiet_startup: bool,
    pub default_project_trust: ProjectTrust,
    pub enable_install_telemetry: bool,
    pub external_editor: Option<String>,
    pub tui_mode: String,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub transport: Transport,
    pub http_idle_timeout_ms: u64,
    pub websocket_connect_timeout_ms: u64,
    pub compaction: CompactionSettings,
    pub retry: RetrySettings,
    pub terminal: TerminalSettings,
    pub images: ImageSettings,
    pub default_tools: Option<Vec<String>>,
    pub session_dir: Option<PathBuf>,
    pub enabled_models: Vec<String>,
    pub extensions: Vec<String>,
    pub skills: Vec<String>,
    pub prompts: Vec<String>,
    pub themes: Vec<String>,
    pub packages: Vec<Value>,
    pub enable_skill_commands: bool,
    pub shell_path: Option<PathBuf>,
    pub shell_command_prefix: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            default_provider: None,
            default_model: None,
            default_thinking_level: ThinkingLevel::Off,
            model_thinking_levels: Default::default(),
            hide_thinking_block: false,
            theme: "dark".into(),
            quiet_startup: false,
            default_project_trust: ProjectTrust::Ask,
            enable_install_telemetry: true,
            external_editor: None,
            tui_mode: "regular".into(),
            steering_mode: "one-at-a-time".into(),
            follow_up_mode: "one-at-a-time".into(),
            transport: Transport::Auto,
            http_idle_timeout_ms: 300_000,
            websocket_connect_timeout_ms: 15_000,
            compaction: Default::default(),
            retry: Default::default(),
            terminal: Default::default(),
            images: Default::default(),
            default_tools: None,
            session_dir: None,
            enabled_models: Vec::new(),
            extensions: Vec::new(),
            skills: Vec::new(),
            prompts: Vec::new(),
            themes: Vec::new(),
            packages: Vec::new(),
            enable_skill_commands: true,
            shell_path: None,
            shell_command_prefix: None,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTrust {
    #[default]
    Ask,
    Always,
    Never,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RetrySettings {
    pub enabled: bool,
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub provider: ProviderRetrySettings,
}
impl Default for RetrySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_retries: 3,
            base_delay_ms: 2_000,
            provider: Default::default(),
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderRetrySettings {
    pub timeout_ms: Option<u64>,
    pub max_retries: u32,
    pub max_retry_delay_ms: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalSettings {
    pub show_images: bool,
    pub image_width_cells: u32,
    pub clear_on_shrink: bool,
}
impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            show_images: true,
            image_width_cells: 60,
            clear_on_shrink: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImageSettings {
    pub auto_resize: bool,
    pub block_images: bool,
}
impl Default for ImageSettings {
    fn default() -> Self {
        Self {
            auto_resize: true,
            block_images: false,
        }
    }
}

pub struct SettingsManager {
    global_path: Option<PathBuf>,
    project_path: Option<PathBuf>,
    value: Settings,
    errors: Vec<String>,
}
impl SettingsManager {
    pub async fn create(cwd: &Path, agent_dir: &Path, allow_project: bool) -> Self {
        let global_path = agent_dir.join("settings.json");
        let project_path = cwd.join(".pi/settings.json");
        let mut errors = Vec::new();
        let mut merged = Value::Object(Default::default());
        merge_file(&mut merged, &global_path, &mut errors).await;
        if allow_project {
            merge_file(&mut merged, &project_path, &mut errors).await
        }
        let value = serde_json::from_value(merged)
            .map_err(|error| errors.push(format!("settings validation: {error}")))
            .unwrap_or_default();
        Self {
            global_path: Some(global_path),
            project_path: allow_project.then_some(project_path),
            value,
            errors,
        }
    }
    #[must_use]
    pub fn in_memory(value: Settings) -> Self {
        Self {
            global_path: None,
            project_path: None,
            value,
            errors: Vec::new(),
        }
    }
    #[must_use]
    pub fn get(&self) -> &Settings {
        &self.value
    }
    pub fn get_mut(&mut self) -> &mut Settings {
        &mut self.value
    }
    pub async fn save_global(&mut self) -> Result<(), std::io::Error> {
        if let Some(path) = &self.global_path {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?
            }
            fs::write(
                path,
                serde_json::to_vec_pretty(&self.value).expect("settings serialize"),
            )
            .await?
        }
        Ok(())
    }
    pub async fn save_project(&mut self) -> Result<(), std::io::Error> {
        if let Some(path) = &self.project_path {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?
            }
            fs::write(
                path,
                serde_json::to_vec_pretty(&self.value).expect("settings serialize"),
            )
            .await?
        }
        Ok(())
    }
    pub fn drain_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.errors)
    }
}
async fn merge_file(target: &mut Value, path: &Path, errors: &mut Vec<String>) {
    match fs::read(path).await {
        Ok(data) => match serde_json::from_slice(&data) {
            Ok(value) => merge_json(target, value),
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => errors.push(format!("{}: {error}", path.display())),
    }
}
fn merge_json(target: &mut Value, source: Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_json(target.entry(key).or_insert(Value::Null), value)
            }
        }
        (target, source) => *target = source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recursive_merge() {
        let mut a = serde_json::json!({"a":{"x":1,"y":2}});
        merge_json(&mut a, serde_json::json!({"a":{"y":3}}));
        assert_eq!(a, serde_json::json!({"a":{"x":1,"y":3}}));
    }
}
