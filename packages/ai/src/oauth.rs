use std::{collections::BTreeMap, time::Duration};

use async_trait::async_trait;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{AiError, Credential};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthPromptKind {
    Text,
    Secret,
    Select,
    ManualCode,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthPrompt {
    pub kind: AuthPromptKind,
    pub message: String,
    #[serde(default)]
    pub options: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthNotification {
    Info {
        message: String,
    },
    AuthUrl {
        url: String,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
    },
    Progress {
        message: String,
    },
}
#[async_trait]
pub trait AuthInteraction: Send + Sync {
    async fn prompt(&self, prompt: AuthPrompt, cancellation: CancellationToken) -> Result<String, AiError>;
    fn notify(&self, notification: AuthNotification);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}
#[must_use]
pub fn create_pkce() -> Pkce {
    let mut bytes = [0_u8; 64];
    rand::rng().fill(&mut bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

#[derive(Clone, Debug)]
pub struct OAuthConfig {
    pub provider_id: String,
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub redirect_uri: String,
    pub extra_authorize: BTreeMap<String, String>,
}

pub async fn login_pkce(
    config: &OAuthConfig,
    interaction: &dyn AuthInteraction,
    cancellation: CancellationToken,
) -> Result<Credential, AiError> {
    let pkce = create_pkce();
    let state = uuid::Uuid::new_v4().to_string();
    let mut url = url::Url::parse(&config.authorize_url).map_err(|error| AiError::Config(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", &config.redirect_uri)
            .append_pair("scope", &config.scopes.join(" "))
            .append_pair("state", &state)
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256");
        for (key, value) in &config.extra_authorize {
            query.append_pair(key, value);
        }
    }
    interaction.notify(AuthNotification::AuthUrl { url: url.to_string() });
    let response = interaction
        .prompt(
            AuthPrompt {
                kind: AuthPromptKind::ManualCode,
                message: "Paste the authorization code or callback URL".into(),
                options: Vec::new(),
            },
            cancellation.clone(),
        )
        .await?;
    let code =
        extract_code(&response).ok_or_else(|| AiError::Config("authorization response did not contain code".into()))?;
    let client = reqwest::Client::new();
    let request = client.post(&config.token_url);
    let request = if config.token_url.contains("platform.claude.com") {
        request.json(&serde_json::json!({"grant_type":"authorization_code","client_id":config.client_id,"code":code,"state":state,"redirect_uri":config.redirect_uri,"code_verifier":pkce.verifier}))
    } else {
        request.form(&[
            ("grant_type", "authorization_code"),
            ("client_id", config.client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("code_verifier", pkce.verifier.as_str()),
        ])
    };
    let result = request.send().await.map_err(AiError::Http)?;
    if !result.status().is_success() {
        return Err(AiError::Provider {
            status: result.status().as_u16(),
            message: result.text().await.unwrap_or_default(),
        });
    }
    credential_from_token(result.json().await.map_err(AiError::Http)?)
}

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default = "default_interval")]
    pub interval: u64,
    pub expires_in: u64,
}
fn default_interval() -> u64 {
    5
}
pub async fn login_device_code(
    device_url: &str,
    token_url: &str,
    client_id: &str,
    scope: &str,
    interaction: &dyn AuthInteraction,
    cancellation: CancellationToken,
) -> Result<Credential, AiError> {
    let client = reqwest::Client::new();
    let response = client
        .post(device_url)
        .header("accept", "application/json")
        .form(&[("client_id", client_id), ("scope", scope)])
        .send()
        .await
        .map_err(AiError::Http)?;
    if !response.status().is_success() {
        return Err(AiError::Provider {
            status: response.status().as_u16(),
            message: response.text().await.unwrap_or_default(),
        });
    }
    let code: DeviceCode = response.json().await.map_err(AiError::Http)?;
    interaction.notify(AuthNotification::DeviceCode {
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = code.interval;
    loop {
        tokio::select! {()=cancellation.cancelled()=>return Err(AiError::Config("OAuth login aborted".into())),()=tokio::time::sleep(Duration::from_secs(interval))=>{}}
        if tokio::time::Instant::now() >= deadline {
            return Err(AiError::Config("device code expired".into()));
        }
        let response = client
            .post(token_url)
            .header("accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", code.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(AiError::Http)?;
        let status = response.status();
        let value: Value = response.json().await.map_err(AiError::Http)?;
        if status.is_success() {
            return credential_from_token(value);
        }
        match value.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            Some(error) => return Err(AiError::Config(format!("OAuth error: {error}"))),
            None => return Err(AiError::Config("invalid OAuth response".into())),
        }
    }
}

pub async fn refresh_oauth(token_url: &str, client_id: &str, credential: &Credential) -> Result<Credential, AiError> {
    let Credential::Oauth {
        refresh: Some(refresh),
        extra,
        ..
    } = credential
    else {
        return Ok(credential.clone());
    };
    let response = reqwest::Client::new()
        .post(token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh),
        ])
        .send()
        .await
        .map_err(AiError::Http)?;
    if !response.status().is_success() {
        return Err(AiError::Provider {
            status: response.status().as_u16(),
            message: response.text().await.unwrap_or_default(),
        });
    }
    let mut refreshed = credential_from_token(response.json().await.map_err(AiError::Http)?)?;
    if let Credential::Oauth {
        refresh: new_refresh,
        extra: new_extra,
        ..
    } = &mut refreshed
    {
        if new_refresh.is_none() {
            *new_refresh = Some(refresh.clone())
        }
        for (key, value) in extra {
            new_extra.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    Ok(refreshed)
}

fn credential_from_token(value: Value) -> Result<Credential, AiError> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| AiError::Config("token response omitted access_token".into()))?
        .to_owned();
    let refresh = value.get("refresh_token").and_then(Value::as_str).map(str::to_owned);
    let expires = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| chrono::Utc::now().timestamp_millis() + seconds * 1000);
    let extra = value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter(|(key, _)| !matches!(key.as_str(), "access_token" | "refresh_token" | "expires_in"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    Ok(Credential::Oauth {
        access,
        refresh,
        expires,
        extra,
    })
}
fn extract_code(response: &str) -> Option<String> {
    if let Ok(url) = url::Url::parse(response) {
        return url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned());
    }
    response
        .split('#')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_is_url_safe_and_sha256() {
        let value = create_pkce();
        assert!(!value.verifier.contains('='));
        assert_eq!(value.challenge.len(), 43);
    }
    #[test]
    fn extracts_callback_code() {
        assert_eq!(
            extract_code("http://localhost/callback?code=abc&state=x").as_deref(),
            Some("abc")
        );
    }
}
