#![allow(missing_docs)]
//! Pi coding-agent SDK and CLI runtime, implemented entirely in Rust.

mod app;
mod cli;
mod extensions;
mod interactive;
mod model_runtime;
mod modes;
mod package_manager;
mod resources;
mod session;
mod settings;

pub use app::*;
pub use cli::*;
pub use extensions::*;
pub use interactive::*;
pub use model_runtime::*;
pub use modes::*;
pub use package_manager::*;
pub use pi_agent_core;
pub use pi_ai;
pub use pi_tui;
pub use resources::*;
pub use session::*;
pub use settings::*;

use std::path::{Path, PathBuf};

use anyhow::Result;

pub const CONFIG_DIR_NAME: &str = ".pi";

pub async fn export_session_html(input: &Path, output: Option<&Path>) -> Result<PathBuf> {
    let session = pi_agent_core::SessionManager::open(input).await?;
    let output = output
        .map(Path::to_owned)
        .unwrap_or_else(|| input.with_extension("html"));
    let mut body = String::new();
    for entry in session.entries() {
        if let pi_agent_core::SessionEntryData::Message { message } = &entry.data {
            body.push_str("<article><pre>");
            body.push_str(&escape_html(&serde_json::to_string_pretty(message)?));
            body.push_str("</pre></article>\n")
        }
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Pi session</title><style>body{{max-width:900px;margin:auto;font:15px system-ui;background:#18181e;color:#eee}}article{{padding:1rem;margin:1rem;background:#24242c;border-radius:8px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere}}</style></head><body><h1>Pi session</h1>{body}</body></html>"
    );
    tokio::fs::write(&output, html).await?;
    Ok(output)
}
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
