#![allow(missing_docs)]

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Response, header},
    routing::post,
};
use pi_ai::{
    Context, HttpProvider, InMemoryCredentialStore, InputKind, Model, ModelCost, Models, StopReason, StreamOptions,
};

fn model(base: String) -> Model {
    model_api(base, "openai-completions")
}
fn model_api(base: String, api: &str) -> Model {
    Model {
        id: "test-model".into(),
        name: "Test".into(),
        api: api.into(),
        provider: "test".into(),
        base_url: base,
        reasoning: false,
        input: vec![InputKind::Text],
        cost: ModelCost::default(),
        context_window: 1000,
        max_tokens: 100,
        headers: Default::default(),
        sampling_params: Default::default(),
        compat: Default::default(),
        thinking_level_map: Default::default(),
    }
}

async fn serve(path: &'static str, body: &'static str) -> std::net::SocketAddr {
    let app = Router::new().route(
        path,
        post(move || async move {
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from(body))
                .unwrap()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    address
}

async fn complete(model: Model) -> pi_ai::AssistantMessage {
    let models = Models::new(Arc::new(InMemoryCredentialStore::default()));
    models.set_provider(Arc::new(HttpProvider::new(
        "test",
        "Test",
        vec![model.clone()],
        std::iter::empty::<String>(),
    )));
    models.set_runtime_api_key("test", "test");
    models
        .complete(&model, &Context::default(), StreamOptions::default())
        .await
        .unwrap()
}

#[tokio::test]
async fn parses_openai_sse() {
    let app=Router::new().route("/v1/chat/completions",post(||async{Response::builder().header(header::CONTENT_TYPE,"text/event-stream").body(Body::from(concat!("data: {\"model\":\"actual\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n","data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n","data: [DONE]\n\n"))).unwrap()}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let model = model(format!("http://{address}/v1"));
    let models = Models::new(Arc::new(InMemoryCredentialStore::default()));
    models.set_provider(Arc::new(HttpProvider::new(
        "test",
        "Test",
        vec![model.clone()],
        std::iter::empty::<String>(),
    )));
    models.set_runtime_api_key("test", "test");
    let response = models
        .complete(&model, &Context::default(), StreamOptions::default())
        .await
        .unwrap();
    assert_eq!(response.text(), "hello");
    assert_eq!(response.stop_reason, StopReason::Stop);
    assert_eq!(response.usage.total_tokens, 5);
}

#[tokio::test]
async fn parses_anthropic_sse() {
    let body = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"usage\":{\"input_tokens\":4}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Claude\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n"
    );
    let address = serve("/v1/messages", body).await;
    let response = complete(model_api(format!("http://{address}/v1"), "anthropic-messages")).await;
    assert_eq!(response.text(), "Claude");
    assert_eq!(response.usage.input, 4);
}

#[tokio::test]
async fn parses_responses_sse() {
    let body = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Open\"}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"AI\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n"
    );
    let address = serve("/v1/responses", body).await;
    let response = complete(model_api(format!("http://{address}/v1"), "openai-responses")).await;
    assert_eq!(response.text(), "OpenAI");
    assert_eq!(response.response_id.as_deref(), Some("resp_1"));
}

#[tokio::test]
async fn parses_google_sse() {
    let body = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Gemini\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":1,\"totalTokenCount\":4}}\n\n";
    let address = serve("/v1/models/test-model:streamGenerateContent", body).await;
    let mut model = model_api(format!("http://{address}/v1"), "google-generative-ai");
    model.base_url = format!("http://{address}/v1");
    let response = complete(model).await;
    assert_eq!(response.text(), "Gemini");
}

#[tokio::test]
async fn parses_mistral_wrapped_sse() {
    let body = concat!(
        "data: {\"data\":{\"choices\":[{\"delta\":{\"content\":\"Mistral\"},\"finish_reason\":\"stop\"}]}}\n\n",
        "data: [DONE]\n\n"
    );
    let address = serve("/v1/chat/completions", body).await;
    let response = complete(model_api(format!("http://{address}/v1"), "mistral-conversations")).await;
    assert_eq!(response.text(), "Mistral");
}
