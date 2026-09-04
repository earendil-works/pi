use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Content, CredentialStore, ModelCost, Usage};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagesModel {
    pub id: String,
    pub name: String,
    pub api: String,
    pub provider: String,
    pub base_url: String,
    pub input: Vec<crate::InputKind>,
    pub output: Vec<ImagesOutputKind>,
    pub cost: ModelCost,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagesOutputKind {
    Text,
    Image,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ImagesContext {
    pub input: Vec<Content>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImagesStopReason {
    Stop,
    Error,
    Aborted,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantImages {
    pub api: String,
    pub provider: String,
    pub model: String,
    pub output: Vec<Content>,
    pub response_id: Option<String>,
    pub usage: Option<Usage>,
    pub stop_reason: ImagesStopReason,
    pub error_message: Option<String>,
    pub timestamp: i64,
}

#[derive(Clone)]
pub struct ImagesModels {
    models: Vec<ImagesModel>,
    credentials: Arc<dyn CredentialStore>,
    client: reqwest::Client,
}
impl ImagesModels {
    #[must_use]
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            models: Vec::new(),
            credentials,
            client: reqwest::Client::new(),
        }
    }
    pub fn set_models(&mut self, models: Vec<ImagesModel>) {
        self.models = models
    }
    #[must_use]
    pub fn get_models(&self, provider: Option<&str>) -> Vec<ImagesModel> {
        self.models
            .iter()
            .filter(|model| provider.is_none_or(|provider| model.provider == provider))
            .cloned()
            .collect()
    }
    #[must_use]
    pub fn get_model(&self, provider: &str, id: &str) -> Option<ImagesModel> {
        self.models
            .iter()
            .find(|model| model.provider == provider && model.id == id)
            .cloned()
    }
    pub async fn generate_images(
        &self,
        model: &ImagesModel,
        context: &ImagesContext,
        api_key: Option<&str>,
    ) -> AssistantImages {
        let key = if let Some(key) = api_key {
            Some(key.to_owned())
        } else {
            self.credentials
                .read(&model.provider)
                .await
                .ok()
                .flatten()
                .map(|credential| credential.secret().to_owned())
                .or_else(|| std::env::var("OPENROUTER_API_KEY").ok())
        };
        let Some(key) = key else {
            return image_error(model, "no authentication configured");
        };
        let content = context
            .input
            .iter()
            .filter_map(|block| match block {
                Content::Text { text, .. } => Some(json!({"type":"text","text":text})),
                Content::Image { data, mime_type } => {
                    Some(json!({"type":"image_url","image_url":{"url":format!("data:{mime_type};base64,{data}")}}))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let response = self
            .client
            .post(format!("{}/chat/completions", model.base_url.trim_end_matches('/')))
            .bearer_auth(key)
            .header("user-agent", crate::user_agent())
            .json(
                &json!({"model":model.id,"messages":[{"role":"user","content":content}],"modalities":["image","text"]}),
            )
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => return image_error(model, &error.to_string()),
        };
        if !response.status().is_success() {
            return image_error(model, &format!("HTTP {}", response.status()));
        }
        let value: Value = match response.json().await {
            Ok(value) => value,
            Err(error) => return image_error(model, &error.to_string()),
        };
        let mut output = Vec::new();
        if let Some(text) = value.pointer("/choices/0/message/content").and_then(Value::as_str) {
            output.push(Content::text(text))
        }
        if let Some(images) = value.pointer("/choices/0/message/images").and_then(Value::as_array) {
            for image in images {
                if let Some(url) = image
                    .pointer("/image_url/url")
                    .or_else(|| image.get("url"))
                    .and_then(Value::as_str)
                    && let Some((header, data)) = url.split_once(',')
                {
                    let mime = header
                        .strip_prefix("data:")
                        .and_then(|value| value.strip_suffix(";base64"))
                        .unwrap_or("image/png");
                    output.push(Content::Image {
                        data: data.into(),
                        mime_type: mime.into(),
                    })
                }
            }
        }
        AssistantImages {
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            output,
            response_id: value.get("id").and_then(Value::as_str).map(str::to_owned),
            usage: None,
            stop_reason: ImagesStopReason::Stop,
            error_message: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }
}
fn image_error(model: &ImagesModel, error: &str) -> AssistantImages {
    AssistantImages {
        api: model.api.clone(),
        provider: model.provider.clone(),
        model: model.id.clone(),
        output: Vec::new(),
        response_id: None,
        usage: None,
        stop_reason: ImagesStopReason::Error,
        error_message: Some(error.into()),
        timestamp: chrono::Utc::now().timestamp_millis(),
    }
}
#[must_use]
pub fn builtin_images_models(credentials: Arc<dyn CredentialStore>) -> ImagesModels {
    let mut models = ImagesModels::new(credentials);
    models.set_models(vec![ImagesModel {
        id: "google/gemini-2.5-flash-image".into(),
        name: "Gemini 2.5 Flash Image".into(),
        api: "openrouter-images".into(),
        provider: "openrouter".into(),
        base_url: "https://openrouter.ai/api/v1".into(),
        input: vec![crate::InputKind::Text, crate::InputKind::Image],
        output: vec![ImagesOutputKind::Image, ImagesOutputKind::Text],
        cost: ModelCost::default(),
        headers: BTreeMap::new(),
    }]);
    models
}
