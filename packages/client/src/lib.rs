#![allow(missing_docs)]
//! Async client for Pi's routed CBOR protocol, including Unix-domain sockets.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use parking_lot::Mutex;
use pi_protocol::{
    ClientMessage, ErrorBody, PROTOCOL_VERSION, RpcTarget, ServerMessage, SessionTarget, encode_client_message,
};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixStream, unix::OwnedWriteHalf},
    sync::{broadcast, oneshot, watch},
};
use uuid::Uuid;

#[derive(Debug, Error, Clone)]
pub enum ClientError {
    #[error("connection closed")]
    Closed,
    #[error("server identity mismatch: expected {expected}, got {actual}")]
    ServerMismatch { expected: Uuid, actual: Uuid },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("server error {code}: {message}")]
    Server { code: String, message: String },
    #[error("I/O error: {0}")]
    Io(String),
}

struct Inner {
    server_id: Uuid,
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Option<Value>, ClientError>>>>,
    updates: broadcast::Sender<(String, Value)>,
    attachment: watch::Sender<Option<SessionTarget>>,
    closed: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}
impl Client {
    pub async fn connect_unix(path: impl AsRef<Path>, server_id: Uuid) -> Result<Self, ClientError> {
        let stream = UnixStream::connect(path)
            .await
            .map_err(|e| ClientError::Io(e.to_string()))?;
        let (mut reader, mut writer) = stream.into_split();
        writer
            .write_all(
                &encode_client_message(&ClientMessage::Hello {
                    version: PROTOCOL_VERSION,
                })
                .map_err(|e| ClientError::Protocol(e.to_string()))?,
            )
            .await
            .map_err(|e| ClientError::Io(e.to_string()))?;
        let hello = read_message(&mut reader).await?;
        match hello {
            ServerMessage::Hello {
                version,
                server_id: actual,
            } if version == PROTOCOL_VERSION && actual == server_id => {}
            ServerMessage::Hello { server_id: actual, .. } => {
                return Err(ClientError::ServerMismatch {
                    expected: server_id,
                    actual,
                });
            }
            ServerMessage::HelloError { error } => return Err(server_error(error)),
            _ => return Err(ClientError::Protocol("server did not send hello first".into())),
        }
        let (updates, _) = broadcast::channel(1024);
        let (attachment, _) = watch::channel(None);
        let (closed, _) = watch::channel(false);
        let inner = Arc::new(Inner {
            server_id,
            writer: tokio::sync::Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            updates,
            attachment,
            closed,
        });
        let task_inner = inner.clone();
        tokio::spawn(async move {
            loop {
                match read_message(&mut reader).await {
                    Ok(message) => dispatch(&task_inner, message),
                    Err(error) => {
                        let pending = std::mem::take(&mut *task_inner.pending.lock());
                        for (_, sender) in pending {
                            let _ = sender.send(Err(error.clone()));
                        }
                        let _ = task_inner.closed.send(true);
                        break;
                    }
                }
            }
        });
        Ok(Self { inner })
    }
    #[must_use]
    pub fn server_id(&self) -> Uuid {
        self.inner.server_id
    }
    #[must_use]
    pub fn attachment(&self) -> Option<SessionTarget> {
        self.inner.attachment.borrow().clone()
    }
    #[must_use]
    pub fn subscribe_attachment(&self) -> watch::Receiver<Option<SessionTarget>> {
        self.inner.attachment.subscribe()
    }
    #[must_use]
    pub fn subscribe_updates(&self) -> broadcast::Receiver<(String, Value)> {
        self.inner.updates.subscribe()
    }
    pub async fn request(&self, target: RpcTarget, call: Value) -> Result<Option<Value>, ClientError> {
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().insert(id.clone(), sender);
        let frame = encode_client_message(&ClientMessage::Request {
            id: id.clone(),
            target,
            call,
        })
        .map_err(|e| ClientError::Protocol(e.to_string()))?;
        if let Err(error) = self.inner.writer.lock().await.write_all(&frame).await {
            self.inner.pending.lock().remove(&id);
            return Err(ClientError::Io(error.to_string()));
        }
        receiver.await.map_err(|_| ClientError::Closed)?
    }
    pub async fn cancel(&self, id: impl Into<String>, target: RpcTarget) -> Result<(), ClientError> {
        let message = ClientMessage::Cancel { id: id.into(), target };
        self.inner
            .writer
            .lock()
            .await
            .write_all(&encode_client_message(&message).map_err(|e| ClientError::Protocol(e.to_string()))?)
            .await
            .map_err(|e| ClientError::Io(e.to_string()))
    }
    pub async fn close(&self) -> Result<(), ClientError> {
        self.inner
            .writer
            .lock()
            .await
            .shutdown()
            .await
            .map_err(|e| ClientError::Io(e.to_string()))
    }
}

fn dispatch(inner: &Inner, message: ServerMessage) {
    match message {
        ServerMessage::Response { id, ok, result, error } => {
            if let Some(sender) = inner.pending.lock().remove(&id) {
                let value = if ok {
                    Ok(result)
                } else {
                    Err(error.map_or_else(
                        || ClientError::Protocol("failed response omitted error".into()),
                        server_error,
                    ))
                };
                let _ = sender.send(value);
            }
        }
        ServerMessage::ServiceUpdate {
            subscription_id,
            update,
        } => {
            let _ = inner.updates.send((subscription_id, update));
        }
        ServerMessage::Attachment { attachment } => {
            let _ = inner.attachment.send(attachment);
        }
        _ => {}
    }
}
fn server_error(error: ErrorBody) -> ClientError {
    ClientError::Server {
        code: error.code,
        message: error.message,
    }
}
async fn read_message(reader: &mut tokio::net::unix::OwnedReadHalf) -> Result<ServerMessage, ClientError> {
    let mut header = [0; 4];
    reader
        .read_exact(&mut header)
        .await
        .map_err(|e| ClientError::Io(e.to_string()))?;
    let length = u32::from_be_bytes(header) as usize;
    if length > pi_protocol::DEFAULT_MAX_FRAME_LENGTH {
        return Err(ClientError::Protocol("frame exceeds limit".into()));
    }
    let mut payload = vec![0; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|e| ClientError::Io(e.to_string()))?;
    {
        let message: ServerMessage =
            ciborium::de::from_reader(payload.as_slice()).map_err(|e| ClientError::Protocol(e.to_string()))?;
        message.validate().map_err(|e| ClientError::Protocol(e.to_string()))?;
        Ok(message)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixServerRoute {
    pub server_id: Uuid,
    pub path: PathBuf,
}
pub async fn discover_unix_servers(directory: &Path, timeout: Duration) -> Result<Vec<UnixServerRoute>, ClientError> {
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .map_err(|e| ClientError::Io(e.to_string()))?;
    let mut candidates = Vec::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(16));
    while let Some(entry) = entries.next_entry().await.map_err(|e| ClientError::Io(e.to_string()))? {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let stem = name.strip_suffix(".sock").unwrap_or(&name);
        let Ok(server_id) = Uuid::parse_str(stem) else { continue };
        let path = entry.path();
        let semaphore = semaphore.clone();
        candidates.push(tokio::spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                return None;
            };
            match tokio::time::timeout(timeout, Client::connect_unix(&path, server_id)).await {
                Ok(Ok(client)) => {
                    let _ = client.close().await;
                    Some(UnixServerRoute { server_id, path })
                }
                _ => None,
            }
        }));
    }
    let mut routes = Vec::new();
    for task in candidates {
        if let Ok(Some(route)) = task.await {
            routes.push(route)
        }
    }
    Ok(routes)
}
