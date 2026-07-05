use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{AiError, Result};
use crate::types::*;

// ─── Resolved Auth ─────────────────────────────────────────────────────────────

/// Resolved authentication for a request: the concrete API key (or equivalent)
/// plus an optional base_url override from auth configuration.
#[derive(Debug, Clone)]
pub struct ResolvedAuth {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<ProviderHeaders>,
    /// Optional provider-scoped env to merge into request options.
    pub env: Option<ProviderEnv>,
}

// ─── Auth Method ───────────────────────────────────────────────────────────────

/// How a provider authenticates requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    #[serde(rename = "api_key")]
    ApiKey(ApiKeyAuth),
    #[serde(rename = "oauth")]
    OAuth(OAuthAuth),
}

/// Configuration for API-key-based authentication.
///
/// Mirrors the TS `ApiKeyAuth` interface. During resolution, the first set
/// env var wins; otherwise a stored credential is checked.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyAuth {
    /// Human-readable name for the key (e.g. "OpenAI API key").
    pub name: String,
    /// Environment variable names to check, in priority order.
    pub env_vars: Vec<String>,
}

impl ApiKeyAuth {
    /// Create a standard env-var API key auth.
    pub fn new(name: impl Into<String>, env_vars: Vec<String>) -> Self {
        ApiKeyAuth {
            name: name.into(),
            env_vars,
        }
    }

    /// Resolve the API key from environment variables.
    /// Returns the first env var value that is set and non-empty.
    pub fn resolve_from_env(&self) -> Option<(String, String)> {
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

/// Configuration for OAuth-based authentication.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthAuth {
    /// Human-readable name for the OAuth provider.
    pub name: String,
    /// Provider identifier — matches the OAuth provider registry key
    /// (e.g. "anthropic", "github-copilot").
    pub provider: String,
}

impl OAuthAuth {
    pub fn new(name: impl Into<String>, provider: impl Into<String>) -> Self {
        OAuthAuth {
            name: name.into(),
            provider: provider.into(),
        }
    }
}

// ─── Resolve Auth ──────────────────────────────────────────────────────────────

/// Resolve authentication for a provider.
///
/// Returns `None` if the provider is unconfigured (no auth available).
/// Returns an error if auth resolution itself fails.
pub async fn resolve_provider_auth(
    auth: &AuthMethod,
    _override_api_key: Option<&str>,
    _override_env: Option<&ProviderEnv>,
) -> Result<Option<ResolvedAuth>> {
    match auth {
        AuthMethod::ApiKey(api_key_auth) => {
            // Override takes priority
            if let Some(key) = _override_api_key {
                if !key.is_empty() {
                    return Ok(Some(ResolvedAuth {
                        api_key: Some(key.to_string()),
                        base_url: None,
                        headers: None,
                        env: None,
                    }));
                }
            }
            // Check override env
            if let Some(env_map) = _override_env {
                for var in &api_key_auth.env_vars {
                    if let Some(value) = env_map.get(var) {
                        if !value.is_empty() {
                            return Ok(Some(ResolvedAuth {
                                api_key: Some(value.clone()),
                                base_url: None,
                                headers: None,
                                env: None,
                            }));
                        }
                    }
                }
            }
            // Fall back to process env
            if let Some((_source, key)) = api_key_auth.resolve_from_env() {
                return Ok(Some(ResolvedAuth {
                    api_key: Some(key),
                    base_url: None,
                    headers: None,
                    env: None,
                }));
            }
            // Unconfigured
            Ok(None)
        }
        AuthMethod::OAuth(oauth_auth) => {
            // OAuth requires stored credentials via the CredentialStore.
            // Ambient resolution doesn't apply. Return None to indicate
            // "needs login" — the caller handles OAuth through separate paths.
            let _ = oauth_auth;
            Ok(None)
        }
    }
}

// ─── Provider Trait ────────────────────────────────────────────────────────────

/// The central provider abstraction.
///
/// Each provider owns its identity, auth, model catalog, and stream
/// dispatch. This matches the TS `Provider` interface.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Unique provider identifier (e.g. "openai").
    fn id(&self) -> &str;
    /// Human-readable display name (e.g. "OpenAI").
    fn name(&self) -> &str;
    /// Optional base URL for API requests.
    fn base_url(&self) -> Option<&str>;
    /// Optional default HTTP headers.
    fn headers(&self) -> Option<&ProviderHeaders>;

    /// Auth method for this provider.
    fn auth(&self) -> &AuthMethod;

    /// Current known models, sync.
    fn get_models(&self) -> &[Model];

    /// Dynamic providers: re-fetch the model list. Static providers return `None`.
    async fn refresh_models(&self) -> Option<Result<Vec<Model>>> {
        None
    }

    /// Stream with typed options — delegates to the correct API implementation.
    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream;

    /// Stream with simplified (reasoning-level) options.
    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream;
}

// ─── Models Registry ──────────────────────────────────────────────────────────

/// The runtime registry of all providers and models.
///
/// This is the main entry point for consumers: register providers, then
/// call `stream()` or `complete()` to interact with LLMs through a
/// unified interface.
pub struct Models {
    providers: HashMap<String, Arc<dyn Provider>>,
}

impl Models {
    /// Create a new, empty `Models` registry.
    pub fn new() -> Self {
        Models {
            providers: HashMap::new(),
        }
    }

    /// Register a provider. Provider ids are unique — replacing an existing
    /// provider with the same id.
    pub fn set_provider(&mut self, provider: impl Provider + 'static) {
        self.providers
            .insert(provider.id().to_string(), Arc::new(provider));
    }

    /// Remove a provider by id.
    pub fn delete_provider(&mut self, id: &str) {
        self.providers.remove(id);
    }

    /// Remove all providers.
    pub fn clear_providers(&mut self) {
        self.providers.clear();
    }

    /// Get a provider by id.
    pub fn get_provider(&self, id: &str) -> Option<&Arc<dyn Provider>> {
        self.providers.get(id)
    }

    /// List all registered providers.
    pub fn get_providers(&self) -> Vec<&Arc<dyn Provider>> {
        self.providers.values().collect()
    }

    /// Get all models from all providers (or a single provider if specified).
    pub fn get_models(&self, provider_id: Option<&str>) -> Vec<&Model> {
        if let Some(pid) = provider_id {
            self.providers
                .get(pid)
                .map(|p| p.get_models().iter().collect())
                .unwrap_or_default()
        } else {
            self.providers
                .values()
                .flat_map(|p| p.get_models().iter())
                .collect()
        }
    }

    /// Look up a specific model by provider + model id.
    pub fn get_model(&self, provider_id: &str, model_id: &str) -> Option<&Model> {
        self.providers
            .get(provider_id)
            .and_then(|p| p.get_models().iter().find(|m| m.id == model_id))
    }

    /// Ask dynamic providers to re-fetch their model lists.
    ///
    /// With a specific provider, returns an error on fetch failure.
    /// Without one, refreshes all providers best-effort.
    pub async fn refresh(&self, provider_id: Option<&str>) -> Result<()> {
        if let Some(pid) = provider_id {
            let provider = self
                .providers
                .get(pid)
                .ok_or_else(|| AiError::Provider(pid.to_string()))?;
            if let Some(result) = provider.refresh_models().await {
                result?;
            }
        } else {
            // Best-effort: refresh all in parallel, collect errors
            let futures: Vec<_> = self
                .providers
                .values()
                .map(|p| p.refresh_models())
                .collect();
            // We ignore individual errors in all-providers mode (matching TS behavior)
            let _ = futures::future::join_all(futures).await;
        }
        Ok(())
    }

    /// Resolve auth for a model. Returns `None` if the provider is unconfigured.
    pub async fn resolve_auth(
        &self,
        model: &Model,
        api_key: Option<&str>,
        env: Option<&ProviderEnv>,
    ) -> Result<Option<ResolvedAuth>> {
        let provider_id = model.provider.as_str();
        let provider = self
            .providers
            .get(provider_id)
            .ok_or_else(|| AiError::Provider(provider_id.to_string()))?;

        resolve_provider_auth(provider.auth(), api_key, env).await
    }

    /// Apply auth resolution to a model + options, returning the
    /// resolved auth for the request. Port of TS `ModelsImpl.applyAuth()`.
    async fn apply_auth<'a>(
        &self,
        model: &'a Model,
        options: Option<&StreamOptions>,
    ) -> Result<Option<ResolvedAuth>> {
        let api_key = options.and_then(|o| o.api_key.as_deref());
        let env = options.and_then(|o| o.env.as_ref());
        self.resolve_auth(model, api_key, env).await
    }

    /// Stream a completion through the correct provider.
    ///
    /// Resolves auth, then delegates to the provider that owns the model.
    pub fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream {
        use crate::event_stream::create_event_stream;

        let (stream, sender) = create_event_stream();
        let provider_id = model.provider.as_str();

        // Look up provider
        let provider = match self.providers.get(provider_id) {
            Some(p) => Arc::clone(p),
            None => {
                let msg = AssistantMessage::error(
                    model.api,
                    model.provider.clone(),
                    &model.id,
                    format!("Unknown provider: {}", provider_id),
                );
                let _ = sender.push(AssistantMessageEvent::Error {
                    reason: StopReason::Error,
                    error: msg,
                });
                return stream;
            }
        };

        // Auth will be resolved inside the provider's stream() — we pass options
        // through directly since the provider handles auth internally.
        // This matches the TS pattern where `Models.stream()` calls
        // `lazyStream()` which resolves auth asynchronously then delegates.
        let owned_model = model.clone();
        let owned_context = context.clone();
        let owned_options = options.cloned();

        tokio::spawn(async move {
            let result_stream =
                provider.stream(&owned_model, &owned_context, owned_options.as_ref());
            // Forward all events from the provider's stream
            let mut result_stream = Box::pin(result_stream);
            use futures::StreamExt;
            while let Some(event) = result_stream.next().await {
                if sender.push(event).is_err() {
                    break; // Consumer dropped
                }
            }
        });

        stream
    }

    /// Convenience: stream, then collect the final message.
    pub async fn complete(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> Result<AssistantMessage> {
        let stream = self.stream(model, context, options);
        stream.result().await.map_err(|_| {
            AiError::Stream("Stream closed without terminal event".into())
        })
    }

    /// Stream with simplified (reasoning-level) options.
    pub fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream {
        use crate::event_stream::create_event_stream;
        use futures::StreamExt;

        let (stream, sender) = create_event_stream();
        let provider_id = model.provider.as_str();

        let provider = match self.providers.get(provider_id) {
            Some(p) => Arc::clone(p),
            None => {
                let msg = AssistantMessage::error(
                    model.api,
                    model.provider.clone(),
                    &model.id,
                    format!("Unknown provider: {}", provider_id),
                );
                let _ = sender.push(AssistantMessageEvent::Error {
                    reason: StopReason::Error,
                    error: msg,
                });
                return stream;
            }
        };

        let owned_model = model.clone();
        let owned_context = context.clone();
        let owned_options = options.cloned();

        tokio::spawn(async move {
            let result_stream =
                provider.stream_simple(&owned_model, &owned_context, owned_options.as_ref());
            let mut result_stream = Box::pin(result_stream);
            while let Some(event) = result_stream.next().await {
                if sender.push(event).is_err() {
                    break;
                }
            }
        });

        stream
    }

    /// Convenience: stream_simple, then collect the final message.
    pub async fn complete_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> Result<AssistantMessage> {
        let stream = self.stream_simple(model, context, options);
        stream.result().await.map_err(|_| {
            AiError::Stream("Stream closed without terminal event".into())
        })
    }
}

impl Default for Models {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Provider Builder ──────────────────────────────────────────────────────────

/// Configuration for building a provider via `create_provider()`.
///
/// Matches the TS `CreateProviderOptions`.
pub struct ProviderConfig {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub headers: Option<ProviderHeaders>,
    pub auth: AuthMethod,
    pub models: Vec<Model>,
}

impl ProviderConfig {
    pub fn new(id: impl Into<String>, auth: AuthMethod) -> Self {
        ProviderConfig {
            id: id.into(),
            name: None,
            base_url: None,
            headers: None,
            auth,
            models: vec![],
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    pub fn with_headers(mut self, headers: ProviderHeaders) -> Self {
        self.headers = Some(headers);
        self
    }

    pub fn with_models(mut self, models: Vec<Model>) -> Self {
        self.models = models;
        self
    }
}

/// A concrete provider built from a `ProviderConfig`.
///
/// This is the standard built-in provider shape. Custom providers with
/// different stream logic can implement the `Provider` trait directly.
pub struct StandardProvider {
    id: String,
    name: String,
    base_url: Option<String>,
    headers: Option<ProviderHeaders>,
    auth: AuthMethod,
    models: Vec<Model>,
}

impl StandardProvider {
    pub fn new(config: ProviderConfig) -> Self {
        StandardProvider {
            name: config.name.unwrap_or_else(|| config.id.clone()),
            id: config.id,
            base_url: config.base_url,
            headers: config.headers,
            auth: config.auth,
            models: config.models,
        }
    }
}

#[async_trait]
impl Provider for StandardProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn base_url(&self) -> Option<&str> {
        self.base_url.as_deref()
    }

    fn headers(&self) -> Option<&ProviderHeaders> {
        self.headers.as_ref()
    }

    fn auth(&self) -> &AuthMethod {
        &self.auth
    }

    fn get_models(&self) -> &[Model] {
        &self.models
    }

    fn stream(
        &self,
        _model: &Model,
        _context: &Context,
        _options: Option<&StreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream {
        // Default: error — subclasses or specific providers override this.
        // In practice, built-in providers like OpenAI will use API-specific
        // implementations that bypass this default.
        use crate::event_stream::create_event_stream;

        let (stream, sender) = create_event_stream();
        let msg = AssistantMessage::error(
            _model.api,
            _model.provider.clone(),
            &_model.id,
            format!(
                "Provider '{}' uses StandardProvider::stream() which is a stub. \
                 Use a provider-specific implementation instead.",
                self.id
            ),
        );
        let _ = sender.push(AssistantMessageEvent::Error {
            reason: StopReason::Error,
            error: msg,
        });
        stream
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> crate::event_stream::AssistantMessageEventStream {
        // Default: fall through to stream() with extracted base options
        let stream_opts = options.map(|o| o.base.clone());
        self.stream(model, context, stream_opts.as_ref())
    }
}

/// Build a provider from a `ProviderConfig`.
/// This is the Rust equivalent of TS `createProvider()`.
pub fn create_provider(config: ProviderConfig) -> impl Provider {
    StandardProvider::new(config)
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_auth() -> AuthMethod {
        AuthMethod::ApiKey(ApiKeyAuth::new(
            "Test API Key",
            vec!["TEST_API_KEY".into()],
        ))
    }

    fn make_test_model() -> Model {
        Model {
            id: "test-model".into(),
            name: "Test Model".into(),
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            base_url: "https://api.openai.com/v1".into(),
            reasoning: false,
            thinking_level_map: HashMap::new(),
            input: vec![InputModality::Text],
            cost: ModelCost {
                input: 2.50,
                output: 10.0,
                cache_read: 1.25,
                cache_write: 3.75,
            },
            context_window: 128000,
            max_tokens: 16384,
            headers: HashMap::new(),
        }
    }

    #[test]
    fn test_models_registry() {
        let mut models = Models::new();

        let provider = create_provider(
            ProviderConfig::new("openai", make_test_auth())
                .with_name("OpenAI")
                .with_base_url("https://api.openai.com/v1")
                .with_models(vec![make_test_model()]),
        );

        models.set_provider(provider);

        assert!(models.get_provider("openai").is_some());
        assert!(models.get_provider("unknown").is_none());

        let all_models = models.get_models(None);
        assert_eq!(all_models.len(), 1);
        assert_eq!(all_models[0].id, "test-model");

        let found = models.get_model("openai", "test-model");
        assert!(found.is_some());

        let not_found = models.get_model("openai", "nonexistent");
        assert!(not_found.is_none());
    }

    #[test]
    fn test_delete_provider() {
        let mut models = Models::new();
        let provider = create_provider(
            ProviderConfig::new("openai", make_test_auth())
                .with_models(vec![make_test_model()]),
        );
        models.set_provider(provider);
        assert_eq!(models.get_models(None).len(), 1);

        models.delete_provider("openai");
        assert_eq!(models.get_models(None).len(), 0);
    }

    #[tokio::test]
    async fn test_resolve_auth_unknown_provider() {
        let models = Models::new();
        let model = make_test_model();
        let result = models.resolve_auth(&model, None, None).await;
        assert!(result.is_err()); // Provider not registered
    }

    #[test]
    fn test_api_key_auth_resolve_from_env() {
        let auth = ApiKeyAuth::new("Test", vec!["TEST_API_KEY".into()]);
        // Without env var set, should return None
        std::env::remove_var("TEST_API_KEY");
        assert!(auth.resolve_from_env().is_none());

        // With env var set
        std::env::set_var("TEST_API_KEY", "sk-test123");
        let resolved = auth.resolve_from_env();
        assert!(resolved.is_some());
        assert_eq!(resolved.unwrap().1, "sk-test123");

        std::env::remove_var("TEST_API_KEY");
    }
}
