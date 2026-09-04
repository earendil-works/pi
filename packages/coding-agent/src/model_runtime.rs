use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::Arc,
};

use pi_ai::{HttpProvider, InputKind, Model, ModelCost, Models};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct ModelsFile {
    providers: HashMap<String, ProviderConfig>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    base_url: Option<String>,
    api: Option<String>,
    api_key: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    models: Vec<ModelConfig>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfig {
    id: String,
    name: Option<String>,
    api: Option<String>,
    #[serde(default)]
    reasoning: bool,
    input: Option<Vec<InputKind>>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    cost: Option<ModelCost>,
    #[serde(default)]
    sampling_params: BTreeMap<String, Value>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    compat: BTreeMap<String, Value>,
    #[serde(default)]
    thinking_level_map: BTreeMap<String, Option<String>>,
}

pub struct ModelRuntime {
    pub models: Models,
}
impl ModelRuntime {
    #[must_use]
    pub fn builtin(credentials: Arc<dyn pi_ai::CredentialStore>) -> Self {
        Self {
            models: pi_ai::builtin_models_with_credentials(credentials),
        }
    }
    pub async fn restore_store(&self, path: &Path) -> Vec<String> {
        let data = match tokio::fs::read(path).await {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => return vec![error.to_string()],
        };
        let stored: HashMap<String, Vec<Model>> = match serde_json::from_slice(&data) {
            Ok(stored) => stored,
            Err(error) => return vec![format!("{}: {error}", path.display())],
        };
        let mut diagnostics = Vec::new();
        for (provider, dynamic) in stored {
            let mut merged = self.models.get_models(Some(&provider));
            for model in dynamic {
                if let Some(index) = merged.iter().position(|entry| entry.id == model.id) {
                    merged[index] = model;
                } else {
                    merged.push(model);
                }
            }
            if let Err(error) = self.models.set_provider_models(&provider, merged) {
                diagnostics.push(error.to_string());
            }
        }
        diagnostics
    }

    pub async fn refresh_remote(&self, path: &Path, base_url: &str) -> Vec<String> {
        let client = reqwest::Client::new();
        let mut stored = HashMap::<String, Vec<Model>>::new();
        let mut diagnostics = Vec::new();
        for provider in self.models.get_providers() {
            let url = format!(
                "{}/api/models/providers/{}",
                base_url.trim_end_matches('/'),
                provider.id
            );
            match client
                .get(url)
                .header("accept", "application/json")
                .header("user-agent", pi_ai::user_agent())
                .send()
                .await
            {
                Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {}
                Ok(response) if response.status().is_success() => match response.json::<Value>().await {
                    Ok(value) => {
                        let values = value
                            .as_array()
                            .cloned()
                            .or_else(|| value.get("models").and_then(Value::as_array).cloned())
                            .or_else(|| value.as_object().map(|object| object.values().cloned().collect()))
                            .unwrap_or_default();
                        let models = values
                            .into_iter()
                            .filter_map(|value| serde_json::from_value::<Model>(value).ok())
                            .map(|mut model| {
                                model.provider.clone_from(&provider.id);
                                model
                            })
                            .collect::<Vec<_>>();
                        if !models.is_empty() {
                            let mut merged = self.models.get_models(Some(&provider.id));
                            for model in &models {
                                if let Some(index) = merged.iter().position(|entry| entry.id == model.id) {
                                    merged[index] = model.clone();
                                } else {
                                    merged.push(model.clone());
                                }
                            }
                            let _ = self.models.set_provider_models(&provider.id, merged);
                            stored.insert(provider.id, models);
                        }
                    }
                    Err(error) => diagnostics.push(format!("{}: {error}", provider.id)),
                },
                Ok(response) => diagnostics.push(format!("{}: HTTP {}", provider.id, response.status())),
                Err(error) => diagnostics.push(format!("{}: {error}", provider.id)),
            }
        }
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Err(error) = tokio::fs::write(path, serde_json::to_vec_pretty(&stored).unwrap_or_default()).await {
            diagnostics.push(error.to_string());
        }
        diagnostics
    }

    pub async fn load_custom(&self, path: &Path) -> Vec<String> {
        let mut diagnostics = Vec::new();
        let data = match tokio::fs::read(path).await {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return diagnostics,
            Err(error) => {
                diagnostics.push(error.to_string());
                return diagnostics;
            }
        };
        let file: ModelsFile = match serde_json::from_slice(&data) {
            Ok(file) => file,
            Err(error) => {
                diagnostics.push(format!("{}: {error}", path.display()));
                return diagnostics;
            }
        };
        for (id, config) in file.providers {
            let Some(base_url) = config.base_url.clone() else {
                diagnostics.push(format!("custom provider {id} has no baseUrl"));
                continue;
            };
            let default_api = config.api.clone().unwrap_or_else(|| "openai-completions".into());
            let models = config
                .models
                .into_iter()
                .map(|entry| {
                    let mut headers = config.headers.clone();
                    headers.extend(entry.headers);
                    Model {
                        id: entry.id.clone(),
                        name: entry.name.unwrap_or(entry.id),
                        api: entry.api.unwrap_or_else(|| default_api.clone()),
                        provider: id.clone(),
                        base_url: base_url.clone(),
                        reasoning: entry.reasoning,
                        input: entry.input.unwrap_or_else(|| vec![InputKind::Text]),
                        cost: entry.cost.unwrap_or_default(),
                        context_window: entry.context_window.unwrap_or(128_000),
                        max_tokens: entry.max_tokens.unwrap_or(16_384),
                        headers,
                        sampling_params: entry.sampling_params,
                        compat: entry.compat,
                        thinking_level_map: entry.thinking_level_map,
                    }
                })
                .collect::<Vec<_>>();
            let env_keys = config
                .api_key
                .as_deref()
                .and_then(env_name)
                .into_iter()
                .collect::<Vec<_>>();
            self.models
                .set_provider(Arc::new(HttpProvider::new(&id, &id, models, env_keys)));
            if let Some(key) = config.api_key.as_deref().and_then(resolve_value) {
                self.models.set_runtime_api_key(&id, key)
            }
        }
        diagnostics
    }
    #[must_use]
    pub fn resolve(&self, provider: Option<&str>, pattern: &str) -> Result<Model, String> {
        if let Some((explicit_provider, id)) = pattern.split_once('/')
            && self.models.get_model(explicit_provider, id).is_some()
        {
            return Ok(self.models.get_model(explicit_provider, id).expect("checked"));
        }
        let matches = self
            .models
            .get_models(provider)
            .into_iter()
            .filter(|model| {
                model.id == pattern || model.name.eq_ignore_ascii_case(pattern) || glob_matches(pattern, &model.id)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [model] => Ok(model.clone()),
            [] => Err(format!("No model matches {pattern}")),
            _ => Err(format!(
                "Model pattern {pattern} is ambiguous: {}",
                matches
                    .iter()
                    .map(|model| format!("{}/{}", model.provider, model.id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
}
fn env_name(value: &str) -> Option<String> {
    value
        .strip_prefix('$')
        .map(|name| name.trim_matches(['{', '}']).to_owned())
}
fn resolve_value(value: &str) -> Option<String> {
    if value.starts_with('!') {
        return None;
    }
    if let Some(name) = env_name(value) {
        std::env::var(name).ok()
    } else {
        Some(value.replace("$$", "$").replace("$!", "!"))
    }
}
fn glob_matches(pattern: &str, value: &str) -> bool {
    globset::Glob::new(pattern)
        .ok()
        .is_some_and(|glob| glob.compile_matcher().is_match(value))
}
