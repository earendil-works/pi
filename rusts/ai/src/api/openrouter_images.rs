//! OpenRouter image generation API.
//!
//! Uses OpenRouter's chat completions endpoint with `modalities: ["image"]`
//! to generate images. Never rejects — errors are encoded in-band.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::types::*;

/// Response shape for OpenRouter image generation.
#[derive(Debug, Deserialize)]
struct OpenRouterImageResponse {
    id: Option<String>,
    #[serde(default)]
    choices: Vec<OpenRouterChoice>,
    #[serde(default)]
    usage: Option<OpenRouterUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterChoice {
    #[serde(default)]
    message: OpenRouterMessage,
}

#[derive(Debug, Deserialize, Default)]
struct OpenRouterMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    images: Vec<OpenRouterImage>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterImage {
    /// Base64 data URL, e.g. "data:image/png;base64,iVBORw..."
    image_url: Option<ImageUrl>,
}

#[derive(Debug, Deserialize)]
struct ImageUrl {
    url: String,
    #[serde(default)]
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}

/// Request body for OpenRouter image generation via chat completions.
#[derive(Debug, Serialize)]
struct OpenRouterImageRequest {
    model: String,
    messages: Vec<OpenRouterChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modalities: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct OpenRouterChatMessage {
    role: String,
    content: Vec<OpenRouterContentPart>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum OpenRouterContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl {
        image_url: OpenRouterImageUrl,
    },
}

#[derive(Debug, Serialize)]
struct OpenRouterImageUrl {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Generate images via OpenRouter's chat completions endpoint.
///
/// Never rejects — always returns `AssistantImages` with in-band errors.
pub async fn generate_images(
    model: ImagesModel,
    context: ImagesContext,
    options: Option<ImagesOptions>,
) -> AssistantImages {
    let model_id = model.id.clone();
    match generate_images_inner(&model, &context, options.as_ref()).await {
        Ok(result) => result,
        Err(e) => AssistantImages {
            stop_reason: ImagesStopReason::Error,
            error_message: Some(e.to_string()),
            model: model_id,
            ..Default::default()
        },
    }
}

async fn generate_images_inner(
    model: &ImagesModel,
    context: &ImagesContext,
    options: Option<&ImagesOptions>,
) -> Result<AssistantImages, crate::error::AiError> {
    let api_key = options.and_then(|o| o.api_key.as_deref());
    let timeout_ms = options.and_then(|o| o.timeout_ms).unwrap_or(600_000);

    // Build content parts from context input
    let mut content_parts = Vec::new();
    for item in &context.input {
        match item {
            Content::Text(tc) => {
                content_parts.push(OpenRouterContentPart::Text {
                    text: tc.text.clone(),
                });
            }
            Content::Image(img) => {
                content_parts.push(OpenRouterContentPart::ImageUrl {
                    image_url: OpenRouterImageUrl {
                        url: format!("data:{};base64,{}", img.mime_type, img.data),
                        detail: Some("auto".into()),
                    },
                });
            }
            _ => {} // Skip unsupported content types
        }
    }

    // Determine modalities from model output
    let modalities: Vec<String> = model
        .output
        .iter()
        .map(|m| match m {
            OutputModality::Text => "text".to_string(),
            OutputModality::Image => "image".to_string(),
        })
        .collect();

    let request_body = OpenRouterImageRequest {
        model: model.id.clone(),
        messages: vec![OpenRouterChatMessage {
            role: "user".into(),
            content: content_parts,
        }],
        modalities: Some(modalities),
    };

    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()?;

    let mut http_request = client
        .post(format!(
            "{}/chat/completions",
            model.base_url.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json");

    if let Some(key) = api_key {
        http_request = http_request.header("Authorization", format!("Bearer {}", key));
    }
    if let Some(headers) = options.and_then(|o| o.headers.as_ref()) {
        for (k, v) in headers {
            http_request = http_request.header(k, v);
        }
    }

    let response = http_request.json(&request_body).send().await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(crate::error::AiError::Api {
            status,
            message: body,
        });
    }

    let parsed: OpenRouterImageResponse = response.json().await?;

    let mut output: Vec<Content> = Vec::new();

    for choice in &parsed.choices {
        // Extract text content
        if let Some(ref text) = choice.message.content {
            if !text.is_empty() {
                output.push(Content::text(text));
            }
        }

        // Extract images
        for image in &choice.message.images {
            if let Some(ref img_url) = image.image_url {
                if let Some((mime_type, data)) = parse_data_url(&img_url.url) {
                    output.push(Content::image(data, mime_type));
                }
            }
        }
    }

    let mut usage = Usage::default();
    if let Some(ref u) = parsed.usage {
        usage.input = u.prompt_tokens;
        usage.output = u.completion_tokens;
        usage.total_tokens = u.total_tokens;
        usage.calculate_cost(&model.cost);
    }

    Ok(AssistantImages {
        api: model.api,
        provider: model.provider.clone(),
        model: model.id.clone(),
        output,
        response_id: parsed.id,
        usage: Some(usage),
        stop_reason: ImagesStopReason::Stop,
        error_message: None,
        timestamp: chrono::Utc::now().timestamp_millis(),
    })
}

/// Parse a data URL into (mime_type, base64_data).
fn parse_data_url(url: &str) -> Option<(String, String)> {
    let stripped = url.strip_prefix("data:")?;
    let comma_pos = stripped.find(',')?;
    let mime_type = stripped[..comma_pos].to_string();
    let data = stripped[comma_pos + 1..].to_string();
    // Strip ";base64" suffix from mime type
    let clean_mime = mime_type
        .strip_suffix(";base64")
        .unwrap_or(&mime_type)
        .to_string();
    Some((clean_mime, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_data_url() {
        let (mime, data) =
            parse_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, "iVBORw0KGgo=");
    }
}
