//! Env channels: the owner's client channels to this machine, each running one pi-env session as `serve` runs it over
//! stdio. The client's first message is the text head `{"type":"pi-env","token":"<hex>"}`; the agent answers with the
//! binary message `PI-ENV <token>\n`, then binary messages carry the frame byte stream both ways (their boundaries mean
//! nothing). When the channel ends, everything its session started is killed.

use super::relay::{Host, Sockets};
use super::ws::{Socket, WsMessage};
use crate::{Session, exec, run_session};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How long the client may take to send its head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// The close code for a client that broke the channel's rules: no or an invalid head, or text after it.
const POLICY: u16 = 1008;

/// Serve env channel `id` on a thread of its own: open its socket, check the head, run the session.
pub fn open(host: Arc<Host>, id: String, sockets: Arc<Sockets>) {
    thread::spawn(move || {
        let socket = match host.channel_socket(&id) {
            Ok(socket) => socket,
            Err(error) => {
                super::log::line(&format!("env channel {id}: {error}"));
                // Not paired yet: the relay fails the client's upgrade at once.
                host.refuse(&id, Some(1011));
                host.remove(&id);
                return;
            }
        };
        if sockets.add(&socket) {
            serve(&host, &socket);
        }
        socket.close(1000, "");
        host.remove(&id);
    });
}

fn serve(host: &Host, socket: &Arc<Socket>) {
    socket.set_read_timeout(Some(HEAD_TIMEOUT));
    let token = match socket.recv() {
        Ok(WsMessage::Text(text)) => head_token(text.as_str()),
        _ => None,
    };
    socket.set_read_timeout(None);
    let Some(token) = token else {
        return socket.close(POLICY, "pi-env channels start with a pi-env head");
    };
    if socket
        .send(WsMessage::binary(format!("PI-ENV {token}\n").into_bytes()))
        .is_err()
    {
        return;
    }
    let groups: exec::Groups = Arc::new(Mutex::new(Default::default()));
    host.agent.sessions.lock().unwrap().push(groups.clone());
    let output = socket.clone();
    let silent = socket.clone();
    let _ = run_session(
        Input {
            socket: socket.clone(),
            pending: Vec::new(),
            position: 0,
        },
        move || Output {
            socket: output,
            buffer: Vec::new(),
        },
        Session {
            groups: groups.clone(),
            forwards: Some(host.agent.forwards.clone()),
        },
        // A client that went silent leaves nothing running: cutting the socket ends the session.
        move || silent.terminate(),
    );
    host.agent
        .sessions
        .lock()
        .unwrap()
        .retain(|session| !Arc::ptr_eq(session, &groups));
}

/// The token of a head `{"type":"pi-env","token":"<1 to 64 lowercase hex digits>"}`.
fn head_token(text: &str) -> Option<String> {
    let head: Value = serde_json::from_str(text).ok()?;
    let token = head["token"].as_str()?;
    let valid = head["type"] == "pi-env"
        && (1..=64).contains(&token.len())
        && token
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    valid.then(|| token.to_string())
}

/// The session's input: the payloads of the client's binary messages, ending with the channel.
struct Input {
    socket: Arc<Socket>,
    pending: Vec<u8>,
    position: usize,
}

impl Read for Input {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        while self.position == self.pending.len() {
            match self.socket.recv() {
                Ok(WsMessage::Binary(bytes)) => {
                    self.pending = bytes.to_vec();
                    self.position = 0;
                }
                Ok(WsMessage::Text(_)) => {
                    self.socket.close(POLICY, "text after the head");
                    return Ok(0);
                }
                Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_)) => {}
                Ok(WsMessage::Close(_)) | Err(_) => return Ok(0),
            }
        }
        let count = buffer.len().min(self.pending.len() - self.position);
        buffer[..count].copy_from_slice(&self.pending[self.position..self.position + count]);
        self.position += count;
        Ok(count)
    }
}

/// The session's output: what the frame writer flushes goes out as one binary message.
struct Output {
    socket: Arc<Socket>,
    buffer: Vec<u8>,
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let message = WsMessage::binary(std::mem::take(&mut self.buffer));
        self.socket
            .send(message)
            .map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_pi_env_heads_with_hex_tokens() {
        assert_eq!(
            head_token(r#"{"type":"pi-env","token":"00ff"}"#).as_deref(),
            Some("00ff")
        );
        assert!(head_token(r#"{"type":"pi-env","token":"00FF"}"#).is_none());
        assert!(head_token(r#"{"type":"pi-env","token":""}"#).is_none());
        assert!(
            head_token(&format!(
                r#"{{"type":"pi-env","token":"{}"}}"#,
                "a".repeat(65)
            ))
            .is_none()
        );
        assert!(head_token(r#"{"type":"http","token":"00"}"#).is_none());
        assert!(head_token("PI-ENV").is_none());
    }
}
