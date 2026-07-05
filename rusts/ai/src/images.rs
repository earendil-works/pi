//! Image generation subsystem.
//!
//! Mirrors the chat framework: `ImagesProvider` trait, `ImagesModels` registry,
//! and factory functions. Built-in providers register at startup.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::error::{AiError, Result};
use crate::models::{resolve_provider_auth, AuthMethod, ResolvedAuth};
use crate::types::*;

// ─── ImagesProvider Trait ──────────────────────────────────────────────────────

/// The image-generation provider abstraction.
///
/// Each provider owns identity, auth, model catalog, and generation dispatch.
#[async_trait]
pub trait ImagesProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn auth(&self) -> &AuthMethod;
    fn get_models(&self) -> &[ImagesModel];

    async fn refresh_models(&self) -> Option<Result<Vec<ImagesModel>>> {
        None
    }

    /// Generate images. Never rejects — errors are encoded in-band.
    async fn generate_images(
        &self,
        model: &ImagesModel,
        context: &ImagesContext,
        options: Option<&ImagesOptions>,
    ) -> AssistantImages;
}

// ─── ImagesModels Registry ─────────────────────────────────────────────────────

pub struct ImagesModels {
    providers: HashMap<String, Arc<dyn ImagesProvider>>,
}

impl ImagesModels {
    pub fn new() -> Self {
        ImagesModels {
            providers: HashMap::new(),
        }
    }

    pub fn set_provider(&mut self, provider: impl ImagesProvider + 'static) {
        self.providers
            .insert(provider.id().to_string(), Arc::new(provider));
    }

    pub fn delete_provider(&mut self, id: &str) {
        self.providers.remove(id);
    }

    pub fn get_provider(&self, id: &str) -> Option<&Arc<dyn ImagesProvider>> {
        self.providers.get(id)
    }

    pub fn get_models(&self, provider_id: Option<&str>) -> Vec<&ImagesModel> {
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

    pub fn get_model(&self, provider_id: &str, model_id: &str) -> Option<&ImagesModel> {
        self.providers
            .get(provider_id)
            .and_then(|p| p.get_models().iter().find(|m| m.id == model_id))
    }

    /// Generate images through the correct provider, with auth resolution.
    ///
    /// Never rejects — errors are encoded in-band as `AssistantImages` with
    /// `stop_reason: ImagesStopReason::Error`.
    pub async fn generate_images(
        &self,
        model: &ImagesModel,
        context: &ImagesContext,
        options: Option<&ImagesOptions>,
    ) -> AssistantImages {
        let provider_id = model.provider.as_str();
        let provider = match self.providers.get(provider_id) {
            Some(p) => Arc::clone(p),
            None => {
                return AssistantImages {
                    stop_reason: ImagesStopReason::Error,
                    error_message: Some(format!("Unknown provider: {}", provider_id)),
                    model: model.id.clone(),
                    ..Default::default()
                };
            }
        };

        // Resolve auth
        let api_key = match resolve_provider_auth(
            provider.auth(),
            options.and_then(|o| o.api_key.as_deref()),
            options.and_then(|o| o.env.as_ref()),
        )
        .await
        {
            Ok(Some(resolved)) => resolved.api_key,
            Ok(None) => {
                return AssistantImages {
                    stop_reason: ImagesStopReason::Error,
                    error_message: Some(format!(
                        "No auth configured for {}. Set the required API key.",
                        provider_id
                    )),
                    model: model.id.clone(),
                    ..Default::default()
                };
            }
            Err(e) => {
                return AssistantImages {
                    stop_reason: ImagesStopReason::Error,
                    error_message: Some(e.to_string()),
                    model: model.id.clone(),
                    ..Default::default()
                };
            }
        };

        // Merge api_key into options
        let merged_options = if options.is_some() || api_key.is_some() {
            let mut opts = options.cloned().unwrap_or_default();
            if api_key.is_some() {
                opts.api_key = api_key;
            }
            Some(opts)
        } else {
            options.cloned()
        };

        provider
            .generate_images(model, context, merged_options.as_ref())
            .await
    }
}

impl Default for ImagesModels {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

pub type GenerateFn = Arc<
    dyn Fn(
            ImagesModel,
            ImagesContext,
            Option<ImagesOptions>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AssistantImages> + Send>>
        + Send
        + Sync,
>;

pub struct ImagesProviderConfig {
    pub id: String,
    pub name: Option<String>,
    pub auth: AuthMethod,
    pub models: Vec<ImagesModel>,
    pub generate_fn: GenerateFn,
}

/// A factory-built images provider that delegates to a function.
struct FnImagesProvider {
    id: String,
    name: String,
    auth: AuthMethod,
    models: Vec<ImagesModel>,
    generate_fn: GenerateFn,
}

#[async_trait]
impl ImagesProvider for FnImagesProvider {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn auth(&self) -> &AuthMethod {
        &self.auth
    }
    fn get_models(&self) -> &[ImagesModel] {
        &self.models
    }
    async fn generate_images(
        &self,
        model: &ImagesModel,
        context: &ImagesContext,
        options: Option<&ImagesOptions>,
    ) -> AssistantImages {
        let model = model.clone();
        let context = context.clone();
        let options = options.cloned();
        (self.generate_fn)(model, context, options).await
    }
}

pub fn create_images_provider(config: ImagesProviderConfig) -> impl ImagesProvider {
    FnImagesProvider {
        id: config.id.clone(),
        name: config.name.unwrap_or_else(|| config.id.clone()),
        auth: config.auth,
        models: config.models,
        generate_fn: config.generate_fn,
    }
}


// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_auth() -> AuthMethod {
        use crate::models::ApiKeyAuth;
        AuthMethod::ApiKey(ApiKeyAuth::new("Test", vec!["TEST_KEY".into()]))
    }

    #[tokio::test]
    async fn test_images_models_registry() {
        let mut models = ImagesModels::new();

        let provider = create_images_provider(ImagesProviderConfig {
            id: "test".into(),
            name: Some("Test".into()),
            auth: make_test_auth(),
            models: vec![ImagesModel {
                id: "test-model".into(),
                name: "Test Model".into(),
                api: ImagesApi::OpenRouterImages,
                provider: ProviderId::Custom("test".into()),
                base_url: "https://example.com".into(),
                output: vec![OutputModality::Image],
                cost: ModelCost::default(),
                headers: HashMap::new(),
            }],
            generate_fn: Arc::new(|_m, _c, _o| {
                Box::pin(async { AssistantImages::default() })
            }),
        });

        models.set_provider(provider);

        assert!(models.get_provider("test").is_some());
        assert!(models.get_provider("unknown").is_none());

        let all = models.get_models(None);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "test-model");
    }
}
