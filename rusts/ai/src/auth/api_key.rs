use serde::{Deserialize, Serialize};

/// Configuration for API-key-based authentication.
///
/// Matches the TS `envApiKeyAuth()` helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyAuthConfig {
    /// Human-readable name for the key (e.g. "OpenAI API key").
    pub name: String,
    /// Environment variable names to check, in priority order.
    pub env_vars: Vec<String>,
}

impl ApiKeyAuthConfig {
    /// Create a new API key auth configuration.
    ///
    /// ```rust
    /// use pi_ai::auth::ApiKeyAuthConfig;
    ///
    /// let auth = ApiKeyAuthConfig::new(
    ///     "OpenAI API key",
    ///     vec!["OPENAI_API_KEY"],
    /// );
    /// ```
    pub fn new(name: impl Into<String>, env_vars: Vec<impl Into<String>>) -> Self {
        ApiKeyAuthConfig {
            name: name.into(),
            env_vars: env_vars.into_iter().map(|s| s.into()).collect(),
        }
    }

    /// Resolve the API key from environment variables.
    ///
    /// Returns `(source_name, key)` for the first set env var, or `None`.
    pub fn resolve(&self) -> Option<(String, String)> {
        for var in &self.env_vars {
            if let Ok(value) = std::env::var(var) {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    return Some((var.clone(), value));
                }
            }
        }
        None
    }
}
