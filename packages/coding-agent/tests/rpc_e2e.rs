#![allow(missing_docs)]

use axum::{
    Router,
    body::Body,
    http::{Response, header},
    routing::post,
};
use serde_json::{Value, json};
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use uuid::Uuid;

#[tokio::test]
async fn rpc_prompt_streams_and_settles() {
    let app=Router::new().route("/v1/chat/completions",post(||async{Response::builder().header(header::CONTENT_TYPE,"text/event-stream").body(Body::from("data: {\"choices\":[{\"delta\":{\"content\":\"rpc ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")).unwrap()}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = std::env::temp_dir().join(format!("pi-rpc-test-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(root.join("models.json"),serde_json::to_vec(&json!({"providers":{"local":{"baseUrl":format!("http://{address}/v1"),"api":"openai-completions","apiKey":"test","models":[{"id":"test"}]}}})).unwrap()).await.unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi"))
        .args([
            "--mode",
            "rpc",
            "--no-session",
            "--provider",
            "local",
            "--model",
            "test",
        ])
        .env("PI_CODING_AGENT_DIR", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    stdin
        .write_all(b"{\"id\":\"1\",\"type\":\"prompt\",\"message\":\"hello\"}\n")
        .await
        .unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let mut accepted = false;
    let mut delta = String::new();
    while let Some(line) = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
        .await
        .unwrap()
        .unwrap()
    {
        let value: Value = serde_json::from_str(&line).unwrap();
        if value.get("type").and_then(Value::as_str) == Some("response") {
            accepted = value.get("success").and_then(Value::as_bool) == Some(true)
        }
        if value.get("type").and_then(Value::as_str) == Some("message_update")
            && value.pointer("/assistantMessageEvent/type").and_then(Value::as_str) == Some("text_delta")
        {
            delta.push_str(
                value
                    .pointer("/assistantMessageEvent/delta")
                    .and_then(Value::as_str)
                    .unwrap(),
            )
        }
        if value.get("type").and_then(Value::as_str) == Some("agent_end") {
            break;
        }
    }
    assert!(accepted);
    assert_eq!(delta, "rpc ok");
    stdin.shutdown().await.unwrap();
    drop(stdin);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
    let _ = child.kill().await;
    let _ = tokio::fs::remove_dir_all(root).await;
}
