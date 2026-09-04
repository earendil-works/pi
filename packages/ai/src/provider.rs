use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::{AiError, Context, EventStream, Model, StreamOptions};

#[derive(Clone, Debug, Default)]
pub struct ResolvedAuth {
    pub api_key: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub base_url: Option<String>,
    pub source: Option<String>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn models(&self) -> Vec<Model>;
    fn env_keys(&self) -> &[String];
    fn set_models(&self, _models: Vec<Model>) {}
    fn requires_auth(&self) -> bool {
        !self.env_keys().is_empty()
    }
    fn ambient_auth_configured(&self) -> bool {
        false
    }
    async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
        auth: ResolvedAuth,
    ) -> Result<EventStream, AiError>;
    async fn refresh(&self, _allow_network: bool) -> Result<Vec<Model>, AiError> {
        Ok(self.models())
    }
}

#[derive(Clone)]
pub struct HttpProvider {
    id: String,
    name: String,
    models: Arc<RwLock<Vec<Model>>>,
    env_keys: Vec<String>,
    client: reqwest::Client,
}

impl HttpProvider {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        models: Vec<Model>,
        env_keys: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            models: Arc::new(RwLock::new(models)),
            env_keys: env_keys.into_iter().map(Into::into).collect(),
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl Provider for HttpProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn models(&self) -> Vec<Model> {
        self.models.read().clone()
    }

    fn set_models(&self, models: Vec<Model>) {
        *self.models.write() = models;
    }

    fn env_keys(&self) -> &[String] {
        &self.env_keys
    }

    fn requires_auth(&self) -> bool {
        true
    }

    async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
        auth: ResolvedAuth,
    ) -> Result<EventStream, AiError> {
        crate::http::stream_http(self.client.clone(), model.clone(), context.clone(), options, auth).await
    }
}

pub type SharedProvider = Arc<dyn Provider>;
