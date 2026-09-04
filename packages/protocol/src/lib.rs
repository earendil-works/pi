#![allow(missing_docs)]
//! Versioned CBOR envelopes and incremental byte framing for Pi services.

use std::io::Cursor;

use bytes::{Buf, BytesMut};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u32 = 8;
pub const DEFAULT_MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("invalid protocol value: {0}")]
    Validation(String),
    #[error("invalid frame: {0}")]
    Frame(String),
    #[error("CBOR error: {0}")]
    Cbor(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerTarget {
    pub server_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTarget {
    pub server_id: Uuid,
    pub session_id: String,
    pub attachment_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcTarget {
    Server(ServerTarget),
    Session(SessionTarget),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    Hello { version: u32 },
    Request { id: String, target: RpcTarget, call: Value },
    Cancel { id: String, target: RpcTarget },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerMessage {
    Hello {
        version: u32,
        #[serde(rename = "serverId")]
        server_id: Uuid,
    },
    HelloError {
        error: ErrorBody,
    },
    Response {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ErrorBody>,
    },
    ServiceUpdate {
        #[serde(rename = "subscriptionId")]
        subscription_id: String,
        update: Value,
    },
    Attachment {
        attachment: Option<SessionTarget>,
    },
}

fn validate_id(id: &str, field: &str) -> Result<(), ProtocolError> {
    if id.is_empty() {
        Err(ProtocolError::Validation(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

impl ClientMessage {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Hello { .. } => Ok(()),
            Self::Request { id, target, call } => {
                validate_id(id, "request id")?;
                validate_target(target)?;
                validate_json(call)
            }
            Self::Cancel { id, target } => {
                validate_id(id, "request id")?;
                validate_target(target)
            }
        }
    }
}

impl ServerMessage {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Hello { version, .. } if *version != PROTOCOL_VERSION => Err(ProtocolError::Validation(format!(
                "unsupported protocol version {version}"
            ))),
            Self::Hello { .. } | Self::Attachment { attachment: None } => Ok(()),
            Self::HelloError { error } => validate_error(error),
            Self::Response { id, ok, result, error } => {
                validate_id(id, "response id")?;
                match (*ok, result, error) {
                    (true, result, None) => result.as_ref().map_or(Ok(()), validate_json),
                    (false, None, Some(error)) => validate_error(error),
                    _ => Err(ProtocolError::Validation(
                        "response must contain exactly the result or error shape".into(),
                    )),
                }
            }
            Self::ServiceUpdate {
                subscription_id,
                update,
            } => {
                validate_id(subscription_id, "subscription id")?;
                validate_json(update)
            }
            Self::Attachment {
                attachment: Some(target),
            } => validate_session_target(target),
        }
    }
}

fn validate_error(error: &ErrorBody) -> Result<(), ProtocolError> {
    validate_id(&error.code, "error code")
}

fn validate_target(target: &RpcTarget) -> Result<(), ProtocolError> {
    match target {
        RpcTarget::Server(_) => Ok(()),
        RpcTarget::Session(target) => validate_session_target(target),
    }
}

fn validate_session_target(target: &SessionTarget) -> Result<(), ProtocolError> {
    validate_id(&target.session_id, "session id")?;
    validate_id(&target.attachment_id, "attachment id")
}

fn validate_json(value: &Value) -> Result<(), ProtocolError> {
    fn visit(value: &Value, depth: usize, items: &mut usize) -> Result<(), ProtocolError> {
        if depth > 64 {
            return Err(ProtocolError::Validation("JSON nesting exceeds 64 levels".into()));
        }
        match value {
            Value::Null | Value::Bool(_) | Value::String(_) => Ok(()),
            Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => Ok(()),
            Value::Number(_) => Err(ProtocolError::Validation("non-finite number".into())),
            Value::Array(values) => {
                *items = items.saturating_add(values.len());
                if *items > 1_000_000 {
                    return Err(ProtocolError::Validation("JSON collection exceeds item limit".into()));
                }
                values.iter().try_for_each(|value| visit(value, depth + 1, items))
            }
            Value::Object(values) => {
                *items = items.saturating_add(values.len());
                if *items > 1_000_000 {
                    return Err(ProtocolError::Validation("JSON collection exceeds item limit".into()));
                }
                values.values().try_for_each(|value| visit(value, depth + 1, items))
            }
        }
    }
    visit(value, 0, &mut 0)
}

pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::Frame("payload exceeds u32 length".into()))?;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn encode_client_message(message: &ClientMessage) -> Result<Vec<u8>, ProtocolError> {
    message.validate()?;
    encode_message(message)
}

pub fn encode_server_message(message: &ServerMessage) -> Result<Vec<u8>, ProtocolError> {
    message.validate()?;
    encode_message(message)
}

fn encode_message<T: Serialize>(message: &T) -> Result<Vec<u8>, ProtocolError> {
    let mut payload = Vec::new();
    ciborium::ser::into_writer(message, &mut payload).map_err(|error| ProtocolError::Cbor(error.to_string()))?;
    encode_frame(&payload)
}

#[derive(Debug)]
pub struct FrameDecoder {
    buffer: BytesMut,
    max_frame_length: usize,
    ended: bool,
    failed: bool,
}

impl FrameDecoder {
    #[must_use]
    pub fn new(max_frame_length: Option<usize>) -> Self {
        Self {
            buffer: BytesMut::new(),
            max_frame_length: max_frame_length.unwrap_or(DEFAULT_MAX_FRAME_LENGTH),
            ended: false,
            failed: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, ProtocolError> {
        if self.ended || self.failed {
            return Err(ProtocolError::Frame(
                if self.ended {
                    "decoder has ended"
                } else {
                    "decoder has failed"
                }
                .into(),
            ));
        }
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.buffer.len() < 4 {
                break;
            }
            let length = u32::from_be_bytes(self.buffer[..4].try_into().expect("four-byte slice")) as usize;
            if length > self.max_frame_length {
                self.failed = true;
                self.buffer.clear();
                return Err(ProtocolError::Frame(format!(
                    "frame length {length} exceeds configured limit of {}",
                    self.max_frame_length
                )));
            }
            if self.buffer.len() < 4 + length {
                break;
            }
            self.buffer.advance(4);
            frames.push(self.buffer.split_to(length).to_vec());
        }
        Ok(frames)
    }

    pub fn end(&mut self) -> Result<(), ProtocolError> {
        if self.ended || self.failed {
            return Err(ProtocolError::Frame(
                if self.ended {
                    "decoder has ended"
                } else {
                    "decoder has failed"
                }
                .into(),
            ));
        }
        self.ended = true;
        if !self.buffer.is_empty() {
            self.failed = true;
            self.buffer.clear();
            return Err(ProtocolError::Frame("truncated frame at end of stream".into()));
        }
        Ok(())
    }
}

pub trait WireMessage: DeserializeOwned {
    fn validate_wire(&self) -> Result<(), ProtocolError>;
}

impl WireMessage for ClientMessage {
    fn validate_wire(&self) -> Result<(), ProtocolError> {
        self.validate()
    }
}

impl WireMessage for ServerMessage {
    fn validate_wire(&self) -> Result<(), ProtocolError> {
        self.validate()
    }
}

pub struct MessageDecoder<T> {
    frames: FrameDecoder,
    marker: std::marker::PhantomData<T>,
}

impl<T: WireMessage> MessageDecoder<T> {
    #[must_use]
    pub fn new(max_frame_length: Option<usize>) -> Self {
        Self {
            frames: FrameDecoder::new(max_frame_length),
            marker: std::marker::PhantomData,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<T>, ProtocolError> {
        self.frames
            .push(chunk)?
            .into_iter()
            .map(|payload| {
                let message: T = ciborium::de::from_reader(Cursor::new(payload))
                    .map_err(|error| ProtocolError::Cbor(error.to_string()))?;
                message.validate_wire()?;
                Ok(message)
            })
            .collect()
    }

    pub fn end(&mut self) -> Result<(), ProtocolError> {
        self.frames.end()
    }
}

pub type ClientMessageDecoder = MessageDecoder<ClientMessage>;
pub type ServerMessageDecoder = MessageDecoder<ServerMessage>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_round_trip() {
        let message = ClientMessage::Hello {
            version: PROTOCOL_VERSION,
        };
        let frame = encode_client_message(&message).unwrap();
        let mut decoder = ClientMessageDecoder::new(None);
        let mut decoded = Vec::new();
        for byte in frame {
            decoded.extend(decoder.push(&[byte]).unwrap());
        }
        decoder.end().unwrap();
        assert_eq!(decoded, vec![message]);
    }

    #[test]
    fn rejects_bad_response_union() {
        let message = ServerMessage::Response {
            id: "1".into(),
            ok: true,
            result: None,
            error: Some(ErrorBody {
                code: "x".into(),
                message: "x".into(),
            }),
        };
        assert!(message.validate().is_err());
    }
}
