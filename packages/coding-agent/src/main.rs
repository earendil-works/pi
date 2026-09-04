#![allow(missing_docs)]

use std::{
    io::{self, Write},
    sync::Arc,
};

use anyhow::Result;
use clap::Parser;
use pi_ai::{CredentialStore, FileCredentialStore};
use pi_coding_agent::{
    App, Cli, Command, OutputMode, PackageManager, agent_dir, export_session_html, run_native_interactive, run_print,
    run_rpc,
};

#[tokio::main]
async fn main() -> Result<()> {
    std::env::set_current_dir(std::env::current_dir()?)?;
    let cli = Cli::parse();
    if let Some(command) = &cli.command {
        return handle_command(command).await;
    }
    let app = Arc::new(App::create(&cli).await?);
    if let Some(search) = &cli.list_models {
        let search = search.to_ascii_lowercase();
        for model in app.model_runtime.models.get_models(None) {
            let name = format!("{}/{}", model.provider, model.id);
            if search.is_empty()
                || name.to_ascii_lowercase().contains(&search)
                || model.name.to_ascii_lowercase().contains(&search)
            {
                println!("{:<30} {:<48} {}", model.provider, model.id, model.name)
            }
        }
        return Ok(());
    }
    let mut messages = expand_file_arguments(cli.messages.clone()).await?;
    if !atty_stdin() && cli.effective_mode() != OutputMode::Rpc {
        let mut input = String::new();
        io::Read::read_to_string(&mut io::stdin(), &mut input)?;
        if !input.trim().is_empty() {
            messages.insert(0, input)
        }
    }
    match cli.effective_mode() {
        OutputMode::Print => run_print(&app, &messages, false).await?,
        OutputMode::Json => run_print(&app, &messages, true).await?,
        OutputMode::Rpc => run_rpc(app).await?,
        OutputMode::Interactive => run_native_interactive(app, &messages).await?,
    }
    Ok(())
}

async fn handle_command(command: &Command) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let agent = agent_dir()?;
    match command {
        Command::Install { source, local } => {
            let path = PackageManager::new(agent, cwd).install(source, *local).await?;
            println!("Installed {source} at {}", path.display())
        }
        Command::Remove { source, local } | Command::Uninstall { source, local } => {
            PackageManager::new(agent, cwd).remove(source, *local).await?;
            println!("Removed {source}")
        }
        Command::List => {
            let manager = PackageManager::new(agent, cwd);
            for package in manager.list(false).await? {
                println!(
                    "{}",
                    package.as_str().unwrap_or_else(|| package
                        .get("source")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("<invalid>"))
                )
            }
        }
        Command::Update {
            source,
            extensions,
            models,
            self_update,
            all,
            force: _,
        } => {
            if *models {
                let runtime =
                    pi_coding_agent::ModelRuntime::builtin(Arc::new(FileCredentialStore::new(agent.join("auth.json"))));
                let diagnostics = runtime
                    .refresh_remote(&agent.join("models-store.json"), "https://pi.dev")
                    .await;
                if diagnostics.is_empty() {
                    println!("Updated model catalogs");
                } else {
                    for diagnostic in diagnostics {
                        eprintln!("Warning: {diagnostic}");
                    }
                }
            }
            if *extensions || *all || source.is_some() {
                PackageManager::new(agent, cwd).update(source.as_deref(), false).await?
            }
            if *self_update || (!extensions && !models && source.is_none()) {
                println!("Install the latest signed Rust binary with the Pi installer.")
            }
        }
        Command::Config => {
            println!("{}", agent.join("settings.json").display())
        }
        Command::Login { provider, oauth } => {
            let provider = provider.as_deref().unwrap_or("anthropic");
            let store = FileCredentialStore::new(agent.join("auth.json"));
            if *oauth {
                let interaction = TerminalAuthInteraction;
                let cancellation = tokio_util::sync::CancellationToken::new();
                let credential = match provider {
                    "anthropic" => pi_ai::login_pkce(&pi_ai::OAuthConfig { provider_id: provider.into(), authorize_url: "https://claude.ai/oauth/authorize".into(), token_url: "https://platform.claude.com/v1/oauth/token".into(), client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e".into(), scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload".split_whitespace().map(str::to_owned).collect(), redirect_uri: "http://localhost:53692/callback".into(), extra_authorize: Default::default() }, &interaction, cancellation).await?,
                    "openai-codex" => { let mut extra=std::collections::BTreeMap::new();extra.insert("id_token_add_organizations".into(),"true".into());extra.insert("codex_cli_simplified_flow".into(),"true".into());pi_ai::login_pkce(&pi_ai::OAuthConfig { provider_id: provider.into(), authorize_url:"https://auth.openai.com/oauth/authorize".into(),token_url:"https://auth.openai.com/oauth/token".into(),client_id:"app_EMoamEEZ73f0CkXaXp7hrann".into(),scopes:"openid profile email offline_access".split_whitespace().map(str::to_owned).collect(),redirect_uri:"http://localhost:1455/auth/callback".into(),extra_authorize:extra },&interaction,cancellation).await? },
                    "github-copilot" => pi_ai::login_device_code("https://github.com/login/device/code","https://github.com/login/oauth/access_token","Iv1.b507a08c87ecfe98","read:user",&interaction,cancellation).await?,
                    _ => anyhow::bail!("OAuth is not supported for {provider}"),
                };
                store.write(provider, credential).await?;
            } else {
                print!("API key for {provider}: ");
                io::stdout().flush()?;
                let mut key = String::new();
                io::stdin().read_line(&mut key)?;
                store
                    .write(
                        provider,
                        pi_ai::Credential::ApiKey {
                            key: key.trim().into(),
                            env: Default::default(),
                        },
                    )
                    .await?;
            }
            println!("Saved credentials for {provider}")
        }
        Command::Logout { provider } => {
            let provider = provider.as_deref().unwrap_or("anthropic");
            FileCredentialStore::new(agent.join("auth.json"))
                .delete(provider)
                .await?;
            println!("Removed credentials for {provider}")
        }
        Command::Export { input, output } => {
            println!("{}", export_session_html(input, output.as_deref()).await?.display())
        }
    }
    Ok(())
}

struct TerminalAuthInteraction;
#[async_trait::async_trait]
impl pi_ai::AuthInteraction for TerminalAuthInteraction {
    async fn prompt(
        &self,
        prompt: pi_ai::AuthPrompt,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<String, pi_ai::AiError> {
        eprint!("{}: ", prompt.message);
        let _ = io::stderr().flush();
        tokio::select! { ()=cancellation.cancelled()=>Err(pi_ai::AiError::Config("login aborted".into())), result=tokio::task::spawn_blocking(||{let mut value=String::new();io::stdin().read_line(&mut value).map(|_|value)})=>result.map_err(|error|pi_ai::AiError::Config(error.to_string()))?.map(|value|value.trim().to_owned()).map_err(|error|pi_ai::AiError::Config(error.to_string())) }
    }
    fn notify(&self, notification: pi_ai::AuthNotification) {
        match notification {
            pi_ai::AuthNotification::Info { message } | pi_ai::AuthNotification::Progress { message } => {
                eprintln!("{message}")
            }
            pi_ai::AuthNotification::AuthUrl { url } => eprintln!("Open: {url}"),
            pi_ai::AuthNotification::DeviceCode {
                user_code,
                verification_uri,
            } => eprintln!("Open {verification_uri} and enter {user_code}"),
        }
    }
}

async fn expand_file_arguments(arguments: Vec<String>) -> Result<Vec<String>> {
    let mut prompt_parts = Vec::new();
    let mut messages = Vec::new();
    for argument in arguments {
        if let Some(path) = argument.strip_prefix('@') {
            let path = std::path::Path::new(path);
            if path.is_file() {
                let data = tokio::fs::read(path).await?;
                match String::from_utf8(data) {
                    Ok(content) => prompt_parts.push(format!("--- {} ---\n{content}", path.display())),
                    Err(_) => prompt_parts.push(format!("[Binary attachment: {}]", path.display())),
                }
                continue;
            }
        }
        messages.push(argument);
    }
    if prompt_parts.is_empty() {
        Ok(messages)
    } else {
        prompt_parts.extend(messages);
        Ok(vec![prompt_parts.join("\n\n")])
    }
}

fn atty_stdin() -> bool {
    use std::io::IsTerminal;
    io::stdin().is_terminal()
}
