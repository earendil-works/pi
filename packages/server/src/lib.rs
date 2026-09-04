#![allow(missing_docs)]
//! Async routed Pi server and Unix-domain socket transport.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use pi_protocol::{
    ClientMessage, ErrorBody, PROTOCOL_VERSION, RpcTarget, ServerMessage, SessionTarget, encode_server_message,
};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        UnixListener, UnixStream,
        unix::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::Mutex as AsyncMutex,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("unknown session: {0}")]
    SessionNotFound(String),
    #[error("ambiguous session: {0}")]
    SessionAmbiguous(String),
    #[error("stale attachment")]
    StaleAttachment,
    #[error("service error {code}: {message}")]
    Service { code: String, message: String },
}
impl ServerError {
    fn body(&self) -> ErrorBody {
        match self {
            Self::SessionNotFound(message) => ErrorBody {
                code: "session_not_found".into(),
                message: message.clone(),
            },
            Self::SessionAmbiguous(message) => ErrorBody {
                code: "session_ambiguous".into(),
                message: message.clone(),
            },
            Self::StaleAttachment => ErrorBody {
                code: "stale_attachment".into(),
                message: self.to_string(),
            },
            Self::Service { code, message } => ErrorBody {
                code: code.clone(),
                message: message.clone(),
            },
            _ => ErrorBody {
                code: "internal".into(),
                message: self.to_string(),
            },
        }
    }
}

#[async_trait]
pub trait ServerHost: Send + Sync {
    async fn invoke(
        &self,
        target: &RpcTarget,
        call: Value,
        cancellation: CancellationToken,
    ) -> Result<Option<Value>, ServerError>;
    async fn disconnected(&self, _attachment: Option<SessionTarget>) {}
}

pub struct Server<H: ServerHost + 'static> {
    server_id: Uuid,
    path: PathBuf,
    host: Arc<H>,
    shutdown: CancellationToken,
    task: Option<tokio::task::JoinHandle<Result<(), ServerError>>>,
}
impl<H: ServerHost + 'static> Server<H> {
    #[must_use]
    pub fn new(server_id: Uuid, path: impl Into<PathBuf>, host: Arc<H>) -> Self {
        Self {
            server_id,
            path: path.into(),
            host,
            shutdown: CancellationToken::new(),
            task: None,
        }
    }
    pub async fn start(&mut self) -> Result<(), ServerError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?
        }
        if tokio::fs::try_exists(&self.path).await? {
            tokio::fs::remove_file(&self.path).await?
        }
        let listener = UnixListener::bind(&self.path)?;
        let shutdown = self.shutdown.clone();
        let host = self.host.clone();
        let server_id = self.server_id;
        self.task = Some(tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {()=shutdown.cancelled()=>break,accepted=listener.accept()=>{let(stream,_)=accepted?;let host=host.clone();connections.spawn(async move{let _=handle_connection(stream,server_id,host).await;});}}
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            Ok(())
        }));
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<(), ServerError> {
        self.shutdown.cancel();
        if let Some(task) = self.task.take() {
            task.await.map_err(|e| ServerError::Protocol(e.to_string()))??;
        }
        if tokio::fs::try_exists(&self.path).await? {
            tokio::fs::remove_file(&self.path).await?
        }
        Ok(())
    }
    #[must_use]
    pub fn server_id(&self) -> Uuid {
        self.server_id
    }
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl<H: ServerHost + 'static> Drop for Server<H> {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

async fn handle_connection<H: ServerHost + 'static>(
    stream: UnixStream,
    server_id: Uuid,
    host: Arc<H>,
) -> Result<(), ServerError> {
    let (mut reader, writer) = stream.into_split();
    let writer = Arc::new(AsyncMutex::new(writer));
    let hello = read_client(&mut reader).await?;
    match hello {
        ClientMessage::Hello { version } if version == PROTOCOL_VERSION => {
            write_server(
                &writer,
                &ServerMessage::Hello {
                    version: PROTOCOL_VERSION,
                    server_id,
                },
            )
            .await?
        }
        ClientMessage::Hello { version } => {
            write_server(
                &writer,
                &ServerMessage::HelloError {
                    error: ErrorBody {
                        code: "version_mismatch".into(),
                        message: format!("unsupported protocol version {version}"),
                    },
                },
            )
            .await?;
            return Ok(());
        }
        _ => return Err(ServerError::Protocol("client did not send hello first".into())),
    }
    let pending: Arc<Mutex<HashMap<String, CancellationToken>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut tasks = JoinSet::new();
    let attachment: Option<SessionTarget> = None;
    loop {
        let message = match read_client(&mut reader).await {
            Ok(message) => message,
            Err(_) => break,
        };
        match message {
            ClientMessage::Request { id, target, call } => {
                if target_server(&target) != server_id {
                    write_server(
                        &writer,
                        &ServerMessage::Response {
                            id,
                            ok: false,
                            result: None,
                            error: Some(ErrorBody {
                                code: "wrong_server".into(),
                                message: "request target does not match this server".into(),
                            }),
                        },
                    )
                    .await?;
                    continue;
                }
                let token = CancellationToken::new();
                pending.lock().insert(id.clone(), token.clone());
                let writer = writer.clone();
                let host = host.clone();
                let pending = pending.clone();
                tasks.spawn(async move {
                    let response = match host.invoke(&target, call, token).await {
                        Ok(result) => ServerMessage::Response {
                            id: id.clone(),
                            ok: true,
                            result,
                            error: None,
                        },
                        Err(error) => ServerMessage::Response {
                            id: id.clone(),
                            ok: false,
                            result: None,
                            error: Some(error.body()),
                        },
                    };
                    let _ = write_server(&writer, &response).await;
                    pending.lock().remove(&id);
                });
            }
            ClientMessage::Cancel { id, target: _ } => {
                if let Some(token) = pending.lock().get(&id) {
                    token.cancel()
                }
            }
            ClientMessage::Hello { .. } => return Err(ServerError::Protocol("duplicate hello".into())),
        }
    }
    for token in pending.lock().values() {
        token.cancel()
    }
    while tasks.join_next().await.is_some() {}
    host.disconnected(attachment).await;
    Ok(())
}
fn target_server(target: &RpcTarget) -> Uuid {
    match target {
        RpcTarget::Server(target) => target.server_id,
        RpcTarget::Session(target) => target.server_id,
    }
}
async fn read_client(reader: &mut OwnedReadHalf) -> Result<ClientMessage, ServerError> {
    let mut header = [0; 4];
    reader.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header) as usize;
    if length > pi_protocol::DEFAULT_MAX_FRAME_LENGTH {
        return Err(ServerError::Protocol("frame exceeds limit".into()));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    {
        let message: ClientMessage =
            ciborium::de::from_reader(payload.as_slice()).map_err(|e| ServerError::Protocol(e.to_string()))?;
        message.validate().map_err(|e| ServerError::Protocol(e.to_string()))?;
        Ok(message)
    }
}
async fn write_server(writer: &AsyncMutex<OwnedWriteHalf>, message: &ServerMessage) -> Result<(), ServerError> {
    let frame = encode_server_message(message).map_err(|e| ServerError::Protocol(e.to_string()))?;
    writer.lock().await.write_all(&frame).await?;
    Ok(())
}

#[must_use]
pub fn get_unix_socket_path(server_id: Uuid, directory: &Path) -> PathBuf {
    directory.join(format!("{server_id}.sock"))
}
