//! OAuth authentication subsystem.
//!
//! Provides:
//! - Core OAuth types (credentials, device code info, callbacks)
//! - Device code flow polling engine (RFC 8628)
//! - PKCE (Proof Key for Code Exchange) implementation
//! - OAuth provider trait

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::error::{AiError, Result};

// ─── OAuth Credentials ─────────────────────────────────────────────────────────

/// Persisted OAuth token state.
///
/// Extends core token fields with provider-specific extras (e.g. accountId,
/// enterpriseUrl, availableModelIds).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCredentials {
    /// The refresh token string.
    pub refresh_token: String,
    /// The current access token (API key or bearer token).
    pub access_token: String,
    /// Unix epoch milliseconds when the access token expires.
    pub expires_at: i64,
    /// Provider-specific extras (e.g. account_id, enterprise_url).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extras: HashMap<String, String>,
}

impl OAuthCredentials {
    pub fn new(
        refresh_token: impl Into<String>,
        access_token: impl Into<String>,
        expires_at: i64,
    ) -> Self {
        OAuthCredentials {
            refresh_token: refresh_token.into(),
            access_token: access_token.into(),
            expires_at,
            extras: HashMap::new(),
        }
    }

    /// Check if the access token is still valid.
    /// Includes a 5-minute safety margin.
    pub fn is_expired(&self) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        let margin = 5 * 60 * 1000; // 5 minutes
        now >= self.expires_at - margin
    }
}

// ─── OAuth Provider ID ─────────────────────────────────────────────────────────

/// Identifies an OAuth provider (e.g. "anthropic", "github-copilot").
pub type OAuthProviderId = String;

// ─── OAuth Callbacks ───────────────────────────────────────────────────────────

/// Information to display an authorization URL to the user.
#[derive(Debug, Clone)]
pub struct OAuthAuthInfo {
    pub url: String,
    pub instructions: Option<String>,
}

/// Information for a device code flow prompt.
#[derive(Debug, Clone)]
pub struct OAuthDeviceCodeInfo {
    /// The user code the user enters at the verification URI.
    pub user_code: String,
    /// The URI the user visits to enter the code.
    pub verification_uri: String,
    /// Optional polling interval in seconds.
    pub interval_seconds: Option<u64>,
    /// Optional total expiration time in seconds.
    pub expires_in_seconds: Option<u64>,
}

/// A prompt shown to the user during login.
#[derive(Debug, Clone)]
pub struct OAuthPrompt {
    pub message: String,
    pub placeholder: Option<String>,
    /// If true, an empty response is allowed.
    pub allow_empty: bool,
}

/// Callbacks that the OAuth login flow uses to interact with the user.
#[async_trait]
pub trait OAuthLoginCallbacks: Send + Sync {
    /// Signal "open this URL in a browser" to the user.
    async fn on_auth(&self, info: OAuthAuthInfo);

    /// Signal "enter this code at this URL" (device code flow).
    async fn on_device_code(&self, info: OAuthDeviceCodeInfo);

    /// Ask the user for text input. Returns the user's response.
    async fn on_prompt(&self, prompt: OAuthPrompt) -> Result<String>;

    /// Optional status/progress update.
    async fn on_progress(&self, _message: &str) {}
}

// ─── OAuth Provider Trait ──────────────────────────────────────────────────────

/// The interface every OAuth provider must implement.
#[async_trait]
pub trait OAuthProvider: Send + Sync {
    /// Unique provider identifier.
    fn id(&self) -> &str;
    /// Human-readable display name.
    fn name(&self) -> &str;

    /// Run the login flow. Returns fresh credentials.
    async fn login(
        &self,
        callbacks: &dyn OAuthLoginCallbacks,
    ) -> Result<OAuthCredentials>;

    /// Refresh an expired token. Returns fresh credentials.
    async fn refresh_token(
        &self,
        credentials: &OAuthCredentials,
    ) -> Result<OAuthCredentials>;

    /// Extract the API key from stored credentials.
    fn get_api_key(&self, credentials: &OAuthCredentials) -> String;
}

// ─── Device Code Polling Engine ────────────────────────────────────────────────

/// Result of a single device code poll attempt.
#[derive(Debug)]
pub enum OAuthPollResult<T> {
    /// Authorization completed successfully.
    Complete(T),
    /// User hasn't authorized yet, continue polling.
    Pending,
    /// Server requests a longer polling interval (RFC 8628 section 3.5).
    SlowDown,
    /// Unrecoverable error.
    Failed(String),
}

/// Poll the authorization server using the RFC 8628 device code flow.
///
/// Returns once the flow completes successfully, or an error on failure/timeout.
pub async fn poll_oauth_device_code_flow<T, F, Fut>(
    mut poll: F,
    interval_seconds: u64,
    expires_in_seconds: Option<u64>,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<OAuthPollResult<T>>> + Send,
{
    let deadline = expires_in_seconds
        .map(|s| tokio::time::Instant::now() + Duration::from_secs(s));

    let mut interval_ms = (interval_seconds * 1000).max(1000);
    let mut slow_down_count = 0u32;

    loop {
        // Check timeout
        if let Some(deadline) = deadline {
            if tokio::time::Instant::now() >= deadline {
                let msg = if slow_down_count > 0 {
                    "Device code flow timed out. Slow-down responses were received; \
                     clock drift in WSL or VM environments may cause this."
                } else {
                    "Device code flow timed out."
                };
                return Err(AiError::OAuth(msg.into()));
            }
        }

        match poll().await? {
            OAuthPollResult::Complete(value) => return Ok(value),
            OAuthPollResult::Failed(message) => {
                return Err(AiError::OAuth(message));
            }
            OAuthPollResult::SlowDown => {
                slow_down_count += 1;
                interval_ms += 5_000; // RFC 8628 section 3.5
            }
            OAuthPollResult::Pending => {
                // Continue polling
            }
        }

        tokio::time::sleep(Duration::from_millis(interval_ms as u64)).await;
    }
}

// ─── PKCE ──────────────────────────────────────────────────────────────────────

/// A PKCE (Proof Key for Code Exchange) key pair.
#[derive(Debug, Clone)]
pub struct PkcePair {
    /// The code verifier (sent in the token exchange request).
    pub verifier: String,
    /// The code challenge (sent in the authorization request).
    pub challenge: String,
}

/// Generate a PKCE verifier + challenge pair using S256.
///
/// Uses 32 random bytes for the verifier, SHA-256 for the challenge,
/// and base64url encoding throughout.
pub fn generate_pkce() -> PkcePair {
    let mut rng = rand::thread_rng();
    let random_bytes: [u8; 32] = rng.gen();

    let verifier = base64url_encode(&random_bytes);
    let challenge = sha256_base64url(&verifier);

    PkcePair {
        verifier,
        challenge,
    }
}

/// Compute SHA-256 hash and base64url-encode the result.
pub fn sha256_base64url(input: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(input.as_bytes());
    let hash = hasher.finalize();
    base64url_encode(&hash)
}

/// Base64url encode (RFC 4648 section 5) without padding.
fn base64url_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate random hex string for state parameters.
pub fn random_hex_string(len: usize) -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..len).map(|_| rng.gen()).collect();
    hex::encode(&bytes)
}

// ─── Hex encoding helper ───────────────────────────────────────────────────────

mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ─── Credential Store ──────────────────────────────────────────────────────────

/// Abstract credential persistence.
///
/// Implementations store credentials keyed by provider ID.
#[async_trait]
pub trait CredentialStore: Send + Sync {
    /// Read the stored credential for a provider. Returns `None` if not found.
    async fn read(&self, provider_id: &str) -> Option<OAuthCredentials>;

    /// Atomically read-modify-write per provider.
    /// `modify_fn` receives the current credential (or None) and returns
    /// the new credential (or None to delete).
    async fn modify(
        &self,
        provider_id: &str,
        modify_fn: Box<
            dyn FnOnce(Option<OAuthCredentials>) -> Option<OAuthCredentials> + Send,
        >,
    );

    /// Delete a stored credential.
    async fn delete(&self, provider_id: &str);
}

/// In-memory credential store for testing and default usage.
pub struct InMemoryCredentialStore {
    store: std::sync::Mutex<HashMap<String, OAuthCredentials>>,
}

impl InMemoryCredentialStore {
    pub fn new() -> Self {
        InMemoryCredentialStore {
            store: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CredentialStore for InMemoryCredentialStore {
    async fn read(&self, provider_id: &str) -> Option<OAuthCredentials> {
        let guard = self.store.lock().unwrap();
        guard.get(provider_id).cloned()
    }

    async fn modify(
        &self,
        provider_id: &str,
        modify_fn: Box<
            dyn FnOnce(Option<OAuthCredentials>) -> Option<OAuthCredentials> + Send,
        >,
    ) {
        let mut guard = self.store.lock().unwrap();
        let current = guard.get(provider_id).cloned();
        let updated = modify_fn(current);
        match updated {
            Some(cred) => {
                guard.insert(provider_id.to_string(), cred);
            }
            None => {
                guard.remove(provider_id);
            }
        }
    }

    async fn delete(&self, provider_id: &str) {
        let mut guard = self.store.lock().unwrap();
        guard.remove(provider_id);
    }
}

// ─── OAuth Provider Registry ───────────────────────────────────────────────────

use std::sync::{Arc, OnceLock, RwLock};

type OAuthProviderRegistry = RwLock<HashMap<OAuthProviderId, Arc<dyn OAuthProvider>>>;

static OAUTH_PROVIDERS: OnceLock<OAuthProviderRegistry> = OnceLock::new();

fn registry() -> &'static OAuthProviderRegistry {
    OAUTH_PROVIDERS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register an OAuth provider. Replaces any existing provider with the same id.
pub fn register_oauth_provider(provider: impl OAuthProvider + 'static) {
    let mut guard = registry().write().unwrap();
    guard.insert(provider.id().to_string(), Arc::new(provider));
}

/// Unregister an OAuth provider by id.
pub fn unregister_oauth_provider(id: &str) {
    let mut guard = registry().write().unwrap();
    guard.remove(id);
}

/// Look up a registered OAuth provider.
pub fn get_oauth_provider(id: &str) -> Option<Arc<dyn OAuthProvider>> {
    let guard = registry().read().unwrap();
    guard.get(id).cloned()
}

/// List all registered OAuth providers.
pub fn get_oauth_providers() -> Vec<Arc<dyn OAuthProvider>> {
    let guard = registry().read().unwrap();
    guard.values().cloned().collect()
}

// ─── Convenience: Refresh if expired ───────────────────────────────────────────

/// Refresh an OAuth token if expired, then return the API key.
///
/// Returns `(new_credentials, api_key)` on success, or `None` if the
/// provider is unknown.
pub async fn get_oauth_api_key(
    provider_id: &str,
    credentials: &OAuthCredentials,
) -> Result<Option<(OAuthCredentials, String)>> {
    let provider = match get_oauth_provider(provider_id) {
        Some(p) => p,
        None => return Ok(None),
    };

    let creds = if credentials.is_expired() {
        provider.refresh_token(credentials).await?
    } else {
        credentials.clone()
    };

    let api_key = provider.get_api_key(&creds);
    Ok(Some((creds, api_key)))
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_generation() {
        let pkce = generate_pkce();
        assert_eq!(pkce.verifier.len(), 43); // 32 bytes base64url = 43 chars
        assert_eq!(pkce.challenge.len(), 43); // SHA-256 hash also 43 chars
        assert_ne!(pkce.verifier, pkce.challenge);

        // Verify challenge = SHA256(verifier)
        let expected = sha256_base64url(&pkce.verifier);
        assert_eq!(pkce.challenge, expected);
    }

    #[test]
    fn test_credentials_expiry() {
        let now = chrono::Utc::now().timestamp_millis();
        // Far future (1 hour from now) — must be beyond the 5-minute safety margin
        let creds = OAuthCredentials::new("refresh", "access", now + 3_600_000);
        assert!(!creds.is_expired());

        let expired = OAuthCredentials::new("refresh", "access", now - 1); // already expired
        assert!(expired.is_expired());
    }

    #[test]
    fn test_in_memory_credential_store() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let store = InMemoryCredentialStore::new();
            let creds = OAuthCredentials::new("r", "a", 0);

            // Read when empty
            assert!(store.read("test").await.is_none());

            // Write
            store
                .modify("test", Box::new(move |_| Some(creds)))
                .await;

            let read = store.read("test").await;
            assert!(read.is_some());
            assert_eq!(read.unwrap().access_token, "a");

            // Delete
            store
                .modify("test", Box::new(|_| None))
                .await;
            assert!(store.read("test").await.is_none());
        });
    }

    #[tokio::test]
    async fn test_oauth_registry() {
        struct TestProvider;
        #[async_trait]
        impl OAuthProvider for TestProvider {
            fn id(&self) -> &str {
                "test"
            }
            fn name(&self) -> &str {
                "Test"
            }
            async fn login(
                &self,
                _callbacks: &dyn OAuthLoginCallbacks,
            ) -> Result<OAuthCredentials> {
                Ok(OAuthCredentials::new("r", "a", 0))
            }
            async fn refresh_token(
                &self,
                _creds: &OAuthCredentials,
            ) -> Result<OAuthCredentials> {
                Ok(OAuthCredentials::new("r2", "a2", 0))
            }
            fn get_api_key(&self, creds: &OAuthCredentials) -> String {
                creds.access_token.clone()
            }
        }

        register_oauth_provider(TestProvider);
        let provider = get_oauth_provider("test");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().name(), "Test");

        unregister_oauth_provider("test");
        assert!(get_oauth_provider("test").is_none());
    }

    #[tokio::test]
    async fn test_device_code_poll_success() {
        let mut calls = 0;
        let result = poll_oauth_device_code_flow(
            || {
                calls += 1;
                async move {
                    if calls < 3 {
                        Ok(OAuthPollResult::<String>::Pending)
                    } else {
                        Ok(OAuthPollResult::Complete("done".into()))
                    }
                }
            },
            1, // 1 second interval
            Some(30), // 30 second timeout
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "done");
    }

    #[tokio::test]
    async fn test_device_code_poll_slow_down() {
        let mut calls = 0;
        let result = poll_oauth_device_code_flow(
            || {
                calls += 1;
                async move {
                    match calls {
                        1 => Ok(OAuthPollResult::<String>::SlowDown),
                        2 => Ok(OAuthPollResult::Pending),
                        _ => Ok(OAuthPollResult::Complete("done".into())),
                    }
                }
            },
            1,
            Some(30),
        )
        .await;

        assert!(result.is_ok());
    }
}
