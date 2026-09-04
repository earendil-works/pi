#![allow(missing_docs)]

use std::sync::Arc;

use pi_agent_core::SessionManager;
use pi_ai::{FauxProvider, InMemoryCredentialStore, Models, StopReason, faux_assistant_message, faux_text};
use pi_coding_agent::{AgentSession, Resources, Settings};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let model = FauxProvider::default_model("demo", "demo");
    let provider = Arc::new(FauxProvider::new("demo", vec![model.clone()], None));
    provider.set_responses([faux_assistant_message(
        &model,
        vec![faux_text("Hello from Rust Pi")],
        StopReason::Stop,
    )]);
    let models = Models::new(Arc::new(InMemoryCredentialStore::default()));
    models.set_provider(provider);
    let session = AgentSession::new(
        models,
        model,
        Settings::default(),
        Resources::default(),
        SessionManager::in_memory(std::env::current_dir()?),
        std::env::current_dir()?,
        Some(Vec::new()),
        None,
        None,
        None,
    );
    session.prompt("Hello", None).await?;
    println!("{}", pi_coding_agent::last_assistant_text(&session.messages()));
    Ok(())
}
