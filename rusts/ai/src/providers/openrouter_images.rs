use std::collections::HashMap;
use std::sync::Arc;

use crate::api::openrouter_images;
use crate::images::{create_images_provider, ImagesProvider, ImagesProviderConfig};
use crate::models::{ApiKeyAuth, AuthMethod};
use crate::types::*;

// ─── Model Catalog ─────────────────────────────────────────────────────────────

fn openrouter_image_models() -> Vec<ImagesModel> {
    vec![
        // Flux models via OpenRouter
        ImagesModel {
            id: "black-forest-labs/flux-1.1-pro".into(),
            name: "Flux 1.1 Pro".into(),
            api: ImagesApi::OpenRouterImages,
            provider: ProviderId::Known(KnownProvider::OpenRouter),
            base_url: "https://openrouter.ai/api/v1".into(),
            output: vec![OutputModality::Image],
            cost: ModelCost {
                input: 0.0,
                output: 0.0, // OpenRouter pricing varies
                cache_read: 0.0,
                cache_write: 0.0,
            },
            headers: HashMap::new(),
        },
        ImagesModel {
            id: "black-forest-labs/flux-schnell".into(),
            name: "Flux Schnell".into(),
            api: ImagesApi::OpenRouterImages,
            provider: ProviderId::Known(KnownProvider::OpenRouter),
            base_url: "https://openrouter.ai/api/v1".into(),
            output: vec![OutputModality::Image],
            cost: ModelCost::default(),
            headers: HashMap::new(),
        },
        // DALL-E via OpenRouter
        ImagesModel {
            id: "openai/dall-e-3".into(),
            name: "DALL-E 3".into(),
            api: ImagesApi::OpenRouterImages,
            provider: ProviderId::Known(KnownProvider::OpenRouter),
            base_url: "https://openrouter.ai/api/v1".into(),
            output: vec![OutputModality::Image],
            cost: ModelCost::default(),
            headers: HashMap::new(),
        },
    ]
}

// ─── Provider Factory ──────────────────────────────────────────────────────────

/// Create the OpenRouter images provider.
pub fn openrouter_images_provider() -> impl ImagesProvider {
    create_images_provider(ImagesProviderConfig {
        id: "openrouter".into(),
        name: Some("OpenRouter (Images)".into()),
        auth: AuthMethod::ApiKey(ApiKeyAuth::new(
            "OpenRouter API key",
            vec!["OPENROUTER_API_KEY".into()],
        )),
        models: openrouter_image_models(),
        generate_fn: Arc::new(|model, context, options| {
            Box::pin(openrouter_images::generate_images(model, context, options))
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_image_model_catalog() {
        let models = openrouter_image_models();
        assert_eq!(models.len(), 3);
        assert!(models.iter().any(|m| m.id.contains("flux")));
        assert!(models.iter().any(|m| m.id.contains("dall-e")));
    }

    #[test]
    fn test_provider_creation() {
        let provider = openrouter_images_provider();
        assert_eq!(provider.id(), "openrouter");
        assert_eq!(provider.get_models().len(), 3);
    }
}
