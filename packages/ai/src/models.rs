use std::{collections::BTreeMap, sync::Arc};

use futures::StreamExt;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::{
    AiError, AssistantMessage, AssistantMessageEvent, Context, Credential, CredentialStore, EventStream, Model,
    Provider, ResolvedAuth, StreamOptions,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone)]
pub struct Models {
    providers: Arc<RwLock<BTreeMap<String, Arc<dyn Provider>>>>,
    credentials: Arc<dyn CredentialStore>,
    runtime_keys: Arc<RwLock<BTreeMap<String, String>>>,
}

impl Models {
    #[must_use]
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            providers: Arc::new(RwLock::new(BTreeMap::new())),
            credentials,
            runtime_keys: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    pub fn set_provider(&self, provider: Arc<dyn Provider>) {
        self.providers.write().insert(provider.id().to_owned(), provider);
    }

    pub fn remove_provider(&self, provider_id: &str) {
        self.providers.write().remove(provider_id);
    }

    pub fn set_provider_models(&self, provider_id: &str, models: Vec<Model>) -> Result<(), AiError> {
        let provider = self
            .providers
            .read()
            .get(provider_id)
            .cloned()
            .ok_or_else(|| AiError::UnknownProvider(provider_id.to_owned()))?;
        provider.set_models(models);
        Ok(())
    }

    #[must_use]
    pub fn get_providers(&self) -> Vec<ProviderInfo> {
        self.providers
            .read()
            .values()
            .map(|provider| ProviderInfo {
                id: provider.id().to_owned(),
                name: provider.name().to_owned(),
            })
            .collect()
    }

    #[must_use]
    pub fn get_models(&self, provider_id: Option<&str>) -> Vec<Model> {
        self.providers
            .read()
            .values()
            .filter(|provider| provider_id.is_none_or(|id| provider.id() == id))
            .flat_map(|provider| provider.models())
            .collect()
    }

    #[must_use]
    pub fn get_model(&self, provider_id: &str, model_id: &str) -> Option<Model> {
        self.providers
            .read()
            .get(provider_id)
            .and_then(|provider| provider.models().into_iter().find(|model| model.id == model_id))
    }

    pub async fn get_auth(&self, provider_id: &str, options: &StreamOptions) -> Result<Option<ResolvedAuth>, AiError> {
        let provider = self
            .providers
            .read()
            .get(provider_id)
            .cloned()
            .ok_or_else(|| AiError::UnknownProvider(provider_id.to_owned()))?;
        if let Some(key) = &options.api_key {
            return Ok(Some(ResolvedAuth {
                api_key: Some(key.clone()),
                source: Some("explicit".into()),
                ..ResolvedAuth::default()
            }));
        }
        if let Some(key) = self.runtime_keys.read().get(provider_id).cloned() {
            return Ok(Some(ResolvedAuth {
                api_key: Some(key),
                source: Some("runtime override".into()),
                ..ResolvedAuth::default()
            }));
        }
        if let Some(credential) = self.credentials.read(provider_id).await? {
            return Ok(Some(ResolvedAuth {
                api_key: Some(credential.secret().to_owned()),
                source: Some(
                    match credential {
                        Credential::ApiKey { .. } => "stored credential",
                        Credential::Oauth { .. } => "OAuth",
                    }
                    .into(),
                ),
                ..ResolvedAuth::default()
            }));
        }
        for name in provider.env_keys() {
            let value = options.env.get(name).cloned().or_else(|| std::env::var(name).ok());
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                return Ok(Some(ResolvedAuth {
                    api_key: Some(value),
                    source: Some(name.clone()),
                    ..ResolvedAuth::default()
                }));
            }
        }
        if !provider.requires_auth() || provider.ambient_auth_configured() {
            return Ok(Some(ResolvedAuth::default()));
        }
        Ok(None)
    }

    pub async fn get_available(&self) -> Result<Vec<Model>, AiError> {
        let providers = self.providers.read().keys().cloned().collect::<Vec<_>>();
        let mut available = Vec::new();
        for provider_id in providers {
            if self.get_auth(&provider_id, &StreamOptions::default()).await?.is_some() {
                available.extend(self.get_models(Some(&provider_id)));
            }
        }
        Ok(available)
    }

    pub async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
    ) -> Result<EventStream, AiError> {
        let Some(provider) = self.providers.read().get(&model.provider).cloned() else {
            return Ok(crate::failed_stream(
                model,
                format!("unknown provider: {}", model.provider),
                crate::StopReason::Error,
            ));
        };
        let auth = match self.get_auth(&model.provider, &options).await {
            Ok(Some(auth)) => auth,
            Ok(None) => {
                return Ok(crate::failed_stream(
                    model,
                    format!("no authentication configured for provider: {}", model.provider),
                    crate::StopReason::Error,
                ));
            }
            Err(error) => return Ok(crate::failed_stream(model, error.to_string(), crate::StopReason::Error)),
        };
        provider.stream(model, context, options, auth).await
    }

    pub async fn complete(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
    ) -> Result<AssistantMessage, AiError> {
        let mut stream = self.stream(model, context, options).await?;
        let mut latest = None;
        while let Some(event) = stream.next().await {
            match event {
                AssistantMessageEvent::Done { message, .. } => return Ok(message),
                AssistantMessageEvent::Error { error, .. } => return Ok(error),
                AssistantMessageEvent::Start { partial }
                | AssistantMessageEvent::TextStart { partial, .. }
                | AssistantMessageEvent::TextDelta { partial, .. }
                | AssistantMessageEvent::TextEnd { partial, .. }
                | AssistantMessageEvent::ThinkingStart { partial, .. }
                | AssistantMessageEvent::ThinkingDelta { partial, .. }
                | AssistantMessageEvent::ThinkingEnd { partial, .. }
                | AssistantMessageEvent::ToolcallStart { partial, .. }
                | AssistantMessageEvent::ToolcallDelta { partial, .. }
                | AssistantMessageEvent::ToolcallEnd { partial, .. } => latest = Some(partial),
            }
        }
        Err(AiError::Protocol(format!(
            "provider stream ended without a terminal event{}",
            latest.map_or_else(String::new, |message| format!(
                " after {} blocks",
                message.content.len()
            ))
        )))
    }

    pub fn set_runtime_api_key(&self, provider_id: &str, key: impl Into<String>) {
        self.runtime_keys.write().insert(provider_id.to_owned(), key.into());
    }

    pub fn remove_runtime_api_key(&self, provider_id: &str) {
        self.runtime_keys.write().remove(provider_id);
    }

    pub async fn store_credential(&self, provider_id: &str, credential: Credential) -> Result<(), AiError> {
        self.credentials.write(provider_id, credential).await?;
        Ok(())
    }

    pub async fn login_api_key(&self, provider_id: &str, key: impl Into<String>) -> Result<(), AiError> {
        self.store_credential(
            provider_id,
            Credential::ApiKey {
                key: key.into(),
                env: BTreeMap::new(),
            },
        )
        .await
    }

    pub async fn logout(&self, provider_id: &str) -> Result<(), AiError> {
        self.credentials.delete(provider_id).await?;
        Ok(())
    }

    pub async fn refresh(&self, allow_network: bool) -> BTreeMap<String, String> {
        let providers = self.providers.read().values().cloned().collect::<Vec<_>>();
        let mut errors = BTreeMap::new();
        for provider in providers {
            match provider.refresh(allow_network).await {
                Ok(models) => provider.set_models(models),
                Err(error) => {
                    errors.insert(provider.id().to_owned(), error.to_string());
                }
            }
        }
        errors
    }
}
