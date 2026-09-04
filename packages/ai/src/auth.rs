use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::fs;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Credential {
    ApiKey {
        key: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    Oauth {
        access: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refresh: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires: Option<i64>,
        #[serde(flatten)]
        extra: BTreeMap<String, serde_json::Value>,
    },
}

impl Credential {
    #[must_use]
    pub fn secret(&self) -> &str {
        match self {
            Self::ApiKey { key, .. } => key,
            Self::Oauth { access, .. } => access,
        }
    }
}

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("credential I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("credential JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[async_trait]
pub trait CredentialStore: Send + Sync {
    async fn read(&self, provider_id: &str) -> Result<Option<Credential>, CredentialError>;
    async fn list(&self) -> Result<Vec<(String, String)>, CredentialError>;
    async fn write(&self, provider_id: &str, credential: Credential) -> Result<(), CredentialError>;
    async fn delete(&self, provider_id: &str) -> Result<(), CredentialError>;
}

#[derive(Clone, Default)]
pub struct InMemoryCredentialStore {
    credentials: Arc<RwLock<BTreeMap<String, Credential>>>,
}

#[async_trait]
impl CredentialStore for InMemoryCredentialStore {
    async fn read(&self, provider_id: &str) -> Result<Option<Credential>, CredentialError> {
        Ok(self.credentials.read().get(provider_id).cloned())
    }

    async fn list(&self) -> Result<Vec<(String, String)>, CredentialError> {
        Ok(self
            .credentials
            .read()
            .iter()
            .map(|(id, credential)| {
                let kind = match credential {
                    Credential::ApiKey { .. } => "api_key",
                    Credential::Oauth { .. } => "oauth",
                };
                (id.clone(), kind.to_owned())
            })
            .collect())
    }

    async fn write(&self, provider_id: &str, credential: Credential) -> Result<(), CredentialError> {
        self.credentials.write().insert(provider_id.to_owned(), credential);
        Ok(())
    }

    async fn delete(&self, provider_id: &str) -> Result<(), CredentialError> {
        self.credentials.write().remove(provider_id);
        Ok(())
    }
}

#[derive(Clone)]
pub struct FileCredentialStore {
    path: PathBuf,
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl FileCredentialStore {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    async fn load(path: &Path) -> Result<BTreeMap<String, Credential>, CredentialError> {
        match fs::read(path).await {
            Ok(data) => Ok(serde_json::from_slice(&data)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(error.into()),
        }
    }

    async fn save(&self, credentials: &BTreeMap<String, Credential>) -> Result<(), CredentialError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(credentials)?).await?;
        fs::rename(temporary, &self.path).await?;
        Ok(())
    }
}

#[async_trait]
impl CredentialStore for FileCredentialStore {
    async fn read(&self, provider_id: &str) -> Result<Option<Credential>, CredentialError> {
        let _guard = self.gate.lock().await;
        Ok(Self::load(&self.path).await?.get(provider_id).cloned())
    }

    async fn list(&self) -> Result<Vec<(String, String)>, CredentialError> {
        let _guard = self.gate.lock().await;
        Ok(Self::load(&self.path)
            .await?
            .into_iter()
            .map(|(id, credential)| {
                let kind = match credential {
                    Credential::ApiKey { .. } => "api_key",
                    Credential::Oauth { .. } => "oauth",
                };
                (id, kind.to_owned())
            })
            .collect())
    }

    async fn write(&self, provider_id: &str, credential: Credential) -> Result<(), CredentialError> {
        let _guard = self.gate.lock().await;
        let mut credentials = Self::load(&self.path).await?;
        credentials.insert(provider_id.to_owned(), credential);
        self.save(&credentials).await
    }

    async fn delete(&self, provider_id: &str) -> Result<(), CredentialError> {
        let _guard = self.gate.lock().await;
        let mut credentials = Self::load(&self.path).await?;
        credentials.remove(provider_id);
        self.save(&credentials).await
    }
}
