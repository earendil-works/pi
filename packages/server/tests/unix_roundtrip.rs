#![allow(missing_docs)]

use async_trait::async_trait;
use pi_protocol::{RpcTarget, ServerTarget};
use pi_server::{Server, ServerError, ServerHost};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Echo;
#[async_trait]
impl ServerHost for Echo {
    async fn invoke(&self, _: &RpcTarget, call: Value, _: CancellationToken) -> Result<Option<Value>, ServerError> {
        Ok(Some(call))
    }
}
#[tokio::test]
async fn request_round_trip() {
    let id = Uuid::new_v4();
    let path = std::path::PathBuf::from(format!("/tmp/pi-{id}.sock"));
    let mut server = Server::new(id, &path, Arc::new(Echo));
    server.start().await.unwrap();
    let client = pi_client::Client::connect_unix(&path, id).await.unwrap();
    let target = RpcTarget::Server(ServerTarget { server_id: id });
    assert_eq!(
        client.request(target, json!({"ping":true})).await.unwrap(),
        Some(json!({"ping":true}))
    );
    client.close().await.unwrap();
    server.stop().await.unwrap();
}
