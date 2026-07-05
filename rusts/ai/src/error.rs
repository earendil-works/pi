use thiserror::Error;

/// Unified error type for the AI package.
#[derive(Error, Debug)]
pub enum AiError {
    #[error("unknown provider: {0}")]
    Provider(String),

    #[error("auth failure: {0}")]
    Auth(String),

    #[error("API error (status {status}): {message}")]
    Api { status: u16, message: String },

    #[error("stream error: {0}")]
    Stream(String),

    #[error("model source error: {0}")]
    ModelSource(String),

    #[error("OAuth error: {0}")]
    OAuth(String),

    #[error("provider has no API implementation for \"{api}\"")]
    NoApiImplementation { api: String },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result alias used throughout the crate.
pub type Result<T> = std::result::Result<T, AiError>;
