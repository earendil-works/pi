use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result, anyhow};
use directories::BaseDirs;
use pi_agent_core::{AgentTool, SessionManager, create_coding_tools};
use pi_ai::{FileCredentialStore, Model};

use crate::{
    AgentSession, Cli, ExtensionLoadResult, ModelRuntime, ProjectTrust, ResourceLoader, Settings, SettingsManager,
    parse_thinking,
};

pub struct App {
    pub session: Arc<AgentSession>,
    pub model_runtime: ModelRuntime,
    pub extensions: Arc<ExtensionLoadResult>,
    pub settings: Settings,
    pub agent_dir: PathBuf,
    pub session_root: PathBuf,
}
impl App {
    pub async fn create(cli: &Cli) -> Result<Self> {
        let cwd = std::env::current_dir()?;
        let agent_dir = agent_dir()?;
        tokio::fs::create_dir_all(&agent_dir).await?;
        let trusted = resolve_trust(cli, &cwd, &agent_dir).await?;
        let mut settings_manager = SettingsManager::create(&cwd, &agent_dir, trusted).await;
        for error in settings_manager.drain_errors() {
            eprintln!("Warning: {error}")
        }
        let settings = settings_manager.get().clone();
        let credentials = Arc::new(FileCredentialStore::new(agent_dir.join("auth.json")));
        let model_runtime = ModelRuntime::builtin(credentials);
        let mut custom_diagnostics = model_runtime.restore_store(&agent_dir.join("models-store.json")).await;
        custom_diagnostics.extend(model_runtime.load_custom(&agent_dir.join("models.json")).await);
        for diagnostic in custom_diagnostics {
            eprintln!("Warning: {diagnostic}")
        }
        let model = resolve_model(cli, &settings, &model_runtime).await?;
        if let Some(api_key) = &cli.api_key {
            model_runtime.models.set_runtime_api_key(&model.provider, api_key)
        }
        let session_root = cli
            .session_dir
            .clone()
            .or_else(|| std::env::var_os("PI_CODING_AGENT_SESSION_DIR").map(PathBuf::from))
            .or_else(|| settings.session_dir.clone())
            .unwrap_or_else(|| agent_dir.join("sessions"));
        let mut manager = if cli.no_session {
            SessionManager::in_memory(&cwd)
        } else if let Some(path) = &cli.session {
            SessionManager::open(path).await?
        } else if let Some(path) = &cli.fork {
            let source = SessionManager::open(path).await?;
            let leaf = source
                .leaf_id()
                .ok_or_else(|| anyhow!("cannot fork an empty session"))?
                .to_owned();
            source.create_branched_session(&leaf, &session_root).await?
        } else if cli.continue_session || cli.resume {
            SessionManager::continue_recent(&cwd, &session_root).await?
        } else {
            SessionManager::create(&cwd, &session_root).await?
        };
        if let Some(name) = &cli.name {
            manager.append_session_info(normalize_session_name(name)).await?;
        }
        let mut loader = ResourceLoader::new(&cwd, &agent_dir, trusted);
        if !cli.no_prompt_templates {
            for path in &cli.prompt_templates {
                loader.add_prompt_path(path.clone())
            }
            for path in &settings.prompts {
                loader.add_prompt_path(resolve_resource_path(path, &agent_dir))
            }
        }
        if !cli.no_skills {
            for path in &cli.skill {
                loader.add_skill_path(path.clone())
            }
            for path in &settings.skills {
                loader.add_skill_path(resolve_resource_path(path, &agent_dir))
            }
        }
        if !cli.no_themes {
            for path in &cli.theme {
                loader.add_theme_path(path.clone())
            }
            for path in &settings.themes {
                loader.add_theme_path(resolve_resource_path(path, &agent_dir))
            }
        }
        if !cli.no_extensions {
            for path in &cli.extensions {
                loader.add_extension_path(path.clone())
            }
            for path in &settings.extensions {
                loader.add_extension_path(resolve_resource_path(path, &agent_dir))
            }
        }
        let package_manager = crate::PackageManager::new(agent_dir.clone(), cwd.clone());
        for package in &settings.packages {
            if let Some(source) = package
                .as_str()
                .or_else(|| package.get("source").and_then(serde_json::Value::as_str))
            {
                let local = package_manager.resolve_source(source, true);
                let global = package_manager.resolve_source(source, false);
                loader.add_package_path(if local.exists() { local } else { global });
            }
        }
        let mut resources = loader.load().await;
        if cli.no_context_files {
            resources.context_files.clear()
        }
        if cli.no_prompt_templates {
            resources.prompts.clear()
        }
        if cli.no_skills {
            resources.skills.clear()
        }
        if cli.no_themes {
            resources.themes.clear()
        }
        if cli.no_extensions {
            resources.extension_paths.clear()
        }
        for warning in &resources.diagnostics.warnings {
            eprintln!("Warning: {warning}")
        }
        for error in &resources.diagnostics.errors {
            eprintln!("Error: {error}")
        }
        let extensions = Arc::new(ExtensionLoadResult::load(&resources.extension_paths).await);
        for error in &extensions.errors {
            eprintln!("Extension error: {error}")
        }
        let tools = select_tools(cli, &cwd, extensions.tools());
        let session = Arc::new(AgentSession::new(
            model_runtime.models.clone(),
            model,
            settings.clone(),
            resources,
            manager,
            cwd,
            Some(tools),
            Some(Arc::new(crate::NativeExtensionHooks::new(extensions.clone()))),
            cli.system_prompt.clone(),
            cli.append_system_prompt.clone(),
        ));
        if let Some(thinking) = cli.thinking.as_deref().and_then(parse_thinking) {
            session.set_thinking_level(thinking).await?
        }
        extensions
            .emit(
                "session_start",
                &serde_json::json!({"reason":"startup","cwd":session.cwd()}),
            )
            .await;
        Ok(Self {
            session,
            model_runtime,
            extensions,
            settings,
            agent_dir,
            session_root,
        })
    }
}

fn select_tools(cli: &Cli, cwd: &Path, extension_tools: Vec<Arc<dyn AgentTool>>) -> Vec<Arc<dyn AgentTool>> {
    if cli.no_tools {
        return Vec::new();
    }
    let defaults = ["read", "bash", "edit", "write"];
    let mut tools = if cli.no_builtin_tools {
        Vec::new()
    } else {
        create_coding_tools(cwd)
            .into_iter()
            .filter(|tool| defaults.contains(&tool.name()))
            .collect::<Vec<_>>()
    };
    tools.extend(extension_tools);
    let mut by_name = HashMap::new();
    for tool in tools {
        by_name.insert(tool.name().to_owned(), tool);
    }
    let mut tools = by_name.into_values().collect::<Vec<_>>();
    if !cli.tools.is_empty() {
        tools.retain(|tool| cli.tools.contains(&tool.name().to_owned()))
    }
    tools.retain(|tool| !cli.exclude_tools.contains(&tool.name().to_owned()));
    tools.sort_by_key(|tool| tool.name().to_owned());
    tools
}

async fn resolve_model(cli: &Cli, settings: &Settings, runtime: &ModelRuntime) -> Result<Model> {
    let provider = cli.provider.as_deref().or(settings.default_provider.as_deref());
    let pattern = cli.model.as_deref().or(settings.default_model.as_deref());
    if let Some(pattern) = pattern {
        return runtime.resolve(provider, pattern).map_err(|error| anyhow!(error));
    }
    if let Some(provider) = provider {
        return runtime
            .models
            .get_models(Some(provider))
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("No models for provider {provider}"));
    }
    let available = runtime.models.get_available().await?;
    available
        .into_iter()
        .next()
        .or_else(|| runtime.models.get_models(None).into_iter().next())
        .ok_or_else(|| anyhow!("No models are configured"))
}

pub fn agent_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR") {
        return Ok(PathBuf::from(path));
    }
    Ok(BaseDirs::new()
        .context("home directory unavailable")?
        .home_dir()
        .join(".pi/agent"))
}
fn resolve_resource_path(value: &str, base: &Path) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = BaseDirs::new()
    {
        return home.home_dir().join(rest);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() { path } else { base.join(path) }
}
fn normalize_session_name(name: &str) -> String {
    name.replace(['\r', '\n'], " ").trim().chars().take(200).collect()
}

async fn resolve_trust(cli: &Cli, cwd: &Path, agent_dir: &Path) -> Result<bool> {
    if cli.approve {
        return Ok(true);
    }
    if cli.no_approve {
        return Ok(false);
    }
    let path = agent_dir.join("trust.json");
    let map: HashMap<String, bool> = tokio::fs::read(&path)
        .await
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    for ancestor in cwd.ancestors() {
        if let Some(value) = map.get(&ancestor.to_string_lossy().to_string()) {
            return Ok(*value);
        }
    }
    let global: Settings = tokio::fs::read(agent_dir.join("settings.json"))
        .await
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    if global.default_project_trust == ProjectTrust::Always {
        return Ok(true);
    }
    if global.default_project_trust == ProjectTrust::Never {
        return Ok(false);
    }
    let has_project_resources =
        cwd.join(".pi").exists() || cwd.ancestors().any(|ancestor| ancestor.join(".agents/skills").exists());
    if cli.effective_mode() == crate::OutputMode::Interactive && has_project_resources {
        use std::io::{IsTerminal, Write};
        if std::io::stdin().is_terminal() {
            eprint!("Trust project resources in {}? [y/N] ", cwd.display());
            std::io::stderr().flush()?;
            let answer = tokio::task::spawn_blocking(|| {
                let mut answer = String::new();
                std::io::stdin().read_line(&mut answer).map(|_| answer)
            })
            .await??;
            return Ok(matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"));
        }
    }
    Ok(false)
}

pub async fn save_trust(cwd: &Path, agent_dir: &Path, trusted: bool) -> Result<()> {
    let path = agent_dir.join("trust.json");
    let mut map: HashMap<String, bool> = tokio::fs::read(&path)
        .await
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    map.insert(cwd.to_string_lossy().to_string(), trusted);
    tokio::fs::write(path, serde_json::to_vec_pretty(&map)?).await?;
    Ok(())
}
