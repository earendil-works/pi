//! The agent as a Radius relay host: one outbound WebSocket (`pi-server.host.v5`) on which the relay announces every
//! connection to this machine as a channel, as p2's brain (`apps/p2/plugins/radius/brain.ts`) handles them.
//!
//! - Env channels (`ws`, the owner, no forward) get their own channel socket and run a pi-env session
//!   (channel.rs).
//! - Forward channels (`http` or `ws` naming a forward) go to that forward's local port (proxy.rs).
//! - The owner's `http` requests to the machine's own origin get a 404: there is no Pi here.
//! - Everything else is refused with 1008.
//!
//! Heartbeat, replacement and backoff follow the brain: a ping after 20 s without a message from the relay, a lost
//! connection after 60 s, `?replace=1` so a reconnect takes over at once from a host the relay still thinks alive,
//! and a host replaced by another instance (1012 "Server host replaced") reconnects without `replace`, so it waits
//! until the other is gone instead of taking the server back. Reconnects back off from 1 to 30 s.

use super::forwards::Forwards;
use super::net::{self, Origin};
use super::oauth::{self, TokenError, encode};
use super::state::{AgentConfig, Credentials, State};
use super::ws::{self, ConnectError, Socket, WsMessage};
use super::{channel, log, proxy};
use crate::exec;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const HOST_SUBPROTOCOL: &str = "pi-server.host.v5";
const CHANNEL_SUBPROTOCOL: &str = "pi-server.channel.v1";
const PROTOCOL_VERSION: u8 = 2;
const DATA_HEADER_BYTES: usize = 18;
/// Data frame types of the host socket's envelope (2, text, carries HTTP bodies as 1 does).
pub const FRAME_BINARY: u8 = 1;
pub const FRAME_END: u8 = 3;
/// Silence from the relay after which the agent pings it; the relay pings an idle host itself only after 30 s.
const HEARTBEAT_IDLE_MS: u64 = 20_000;
/// Silence from the relay after which the connection counts as lost.
const HEARTBEAT_TIMEOUT_MS: u64 = 60_000;
const HEARTBEAT_TICK: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_INITIAL: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
/// How often a machine whose grant was revoked tries again.
const REVOKED_RETRY: Duration = Duration::from_secs(300);
/// Access tokens are refreshed this long before they expire.
const REFRESH_MARGIN_MS: u64 = 5 * 60_000;
/// The relay's close of a host that another instance with this server ID replaced.
const REPLACED_CODE: u16 = 1012;
const REPLACED_REASON: &str = "Server host replaced";
const OWNER_HTTP_TEXT: &str = "This machine runs pi-env without Pi.\n";

/// What the agent's threads share: its enrollment, credentials, forwards and running sessions.
pub struct Agent {
    pub state: State,
    pub config: AgentConfig,
    pub gateway: Origin,
    pub tokens: Tokens,
    pub forwards: Arc<Forwards>,
    /// The commands of every env session, killed when the agent is stopped.
    pub sessions: Mutex<Vec<exec::Groups>>,
}

/// Run the relay host until the process ends: connect, serve, reconnect.
pub fn run(agent: Arc<Agent>) -> ! {
    let mut retry = RETRY_INITIAL;
    let mut replace = true;
    // A token the gateway answered 401 for, refreshed on the next attempt.
    let mut refused: Option<String> = None;
    loop {
        report(&agent, json!({ "relay": "connecting" }));
        let token = match agent.tokens.access(refused.take().as_deref()) {
            Ok(token) => token,
            Err(TokenFailure::Revoked(message)) => {
                log::line(&format!(
                    "the gateway refused this machine's grant: {message}"
                ));
                report(&agent, json!({ "relay": "revoked", "error": message }));
                thread::sleep(REVOKED_RETRY);
                continue;
            }
            Err(TokenFailure::Replaced) => {
                exit(&agent, "credentials.json changed: enrolled again", 0)
            }
            Err(TokenFailure::Failed(message)) => {
                retry = wait(&agent, &message, retry);
                continue;
            }
        };
        let socket = match connect(&agent, &token, replace) {
            Ok(socket) => socket,
            Err(ConnectError::Refused { status: 401, body }) => {
                refused = Some(token);
                retry = wait(&agent, &format!("401: {body}"), retry);
                continue;
            }
            Err(error) => {
                retry = wait(&agent, &error.to_string(), retry);
                continue;
            }
        };
        retry = RETRY_INITIAL;
        replace = true;
        log::line("connected to the relay");
        report(&agent, json!({ "relay": "connected" }));
        let (code, reason) = serve(&agent, socket);
        let message = if code == REPLACED_CODE && reason == REPLACED_REASON {
            replace = false;
            "another agent with this server ID took over; waiting for it to disconnect".to_string()
        } else {
            format!(
                "relay closed ({code}{}{reason})",
                if reason.is_empty() { "" } else { " " }
            )
        };
        retry = wait(&agent, &message, retry);
    }
}

/// Report `message`, wait `retry`, and return the next wait.
fn wait(agent: &Agent, message: &str, retry: Duration) -> Duration {
    log::line(&format!(
        "relay: {message}; retrying in {} s",
        retry.as_secs()
    ));
    report(agent, json!({ "relay": "retrying", "error": message }));
    thread::sleep(retry);
    (retry * 2).min(RETRY_MAX)
}

/// Stop the agent: kill the commands of every session, log and report why, and exit with `code`. A service manager
/// starts it again, with the state as it is then.
pub fn exit(agent: &Agent, why: &str, code: i32) -> ! {
    for groups in agent.sessions.lock().unwrap().iter() {
        crate::kill_all(groups);
    }
    log::line(&format!("stopping: {why}"));
    report(agent, json!({ "relay": "stopped", "error": why }));
    std::process::exit(code)
}

/// Write `status.json`: the relay state with the time, the process and the server.
fn report(agent: &Agent, mut status: Value) {
    status["pid"] = json!(std::process::id());
    status["serverId"] = json!(agent.config.server_id);
    status["updatedAt"] = json!(log::timestamp(log::now_ms()));
    if let Err(error) = agent.state.write_status(&status) {
        log::line(&format!("writing status.json: {error}"));
    }
}

fn connect(agent: &Agent, token: &str, replace: bool) -> Result<Arc<Socket>, ConnectError> {
    let name = agent.config.name.clone().unwrap_or_else(super::hostname);
    let path = format!(
        "/v1/servers/{}/connect?{}name={}",
        agent.config.server_id,
        if replace { "replace=1&" } else { "" },
        encode(&name)
    );
    let (socket, protocol) = open_socket(agent, &path, HOST_SUBPROTOCOL, token)?;
    if protocol.as_deref() != Some(HOST_SUBPROTOCOL) {
        socket.terminate();
        return Err(ConnectError::Failed(format!(
            "the relay does not speak {HOST_SUBPROTOCOL}"
        )));
    }
    Ok(socket)
}

fn open_socket(
    agent: &Agent,
    path: &str,
    protocol: &str,
    token: &str,
) -> Result<(Arc<Socket>, Option<String>), ConnectError> {
    let stream = net::connect(&agent.gateway, HANDSHAKE_TIMEOUT)
        .map_err(|error| ConnectError::Failed(error.to_string()))?;
    let headers = [("Authorization".to_string(), format!("Bearer {token}"))];
    let (socket, protocol) =
        ws::connect(stream, &agent.gateway.ws_url(path), &[protocol], &headers)?;
    Ok((Arc::new(socket), protocol))
}

/// One host connection, from its open until it is lost.
pub struct Host {
    pub agent: Arc<Agent>,
    socket: Arc<Socket>,
    channels: Mutex<HashMap<String, Channel>>,
    closed: AtomicBool,
    last_received: AtomicU64,
}

/// A channel the relay announced and the host still serves.
pub enum Channel {
    Http(Arc<proxy::HttpChannel>),
    Sockets(Arc<Sockets>),
}

/// The sockets of a WebSocket channel: its channel socket and, for forwards, the local one. Ending the channel cuts
/// them, also those added later.
#[derive(Default)]
pub struct Sockets {
    list: Mutex<Vec<Arc<Socket>>>,
    /// Connections still in their WebSocket handshake.
    streams: Mutex<Vec<TcpStream>>,
    ended: AtomicBool,
}

impl Sockets {
    /// Keep `socket` with the channel; false (and the socket cut) once the channel has ended.
    pub fn add(&self, socket: &Arc<Socket>) -> bool {
        let mut list = self.list.lock().unwrap();
        if self.ended.load(Ordering::SeqCst) {
            socket.terminate();
            return false;
        }
        list.push(socket.clone());
        true
    }

    /// Keep a connection that is not a WebSocket yet with the channel; false (and it cut) once the channel has ended.
    pub fn add_stream(&self, stream: &TcpStream) -> bool {
        let mut streams = self.streams.lock().unwrap();
        let clone = stream.try_clone();
        if self.ended.load(Ordering::SeqCst) || clone.is_err() {
            let _ = stream.shutdown(Shutdown::Both);
            return false;
        }
        streams.extend(clone);
        true
    }

    pub fn end(&self) {
        let (list, streams) = {
            let mut list = self.list.lock().unwrap();
            let mut streams = self.streams.lock().unwrap();
            self.ended.store(true, Ordering::SeqCst);
            (std::mem::take(&mut *list), std::mem::take(&mut *streams))
        };
        for socket in list {
            socket.terminate();
        }
        for stream in streams {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// Serve the host socket until it closes; returns the relay's close code and reason (1006 without a close).
fn serve(agent: &Arc<Agent>, socket: Arc<Socket>) -> (u16, String) {
    let host = Arc::new(Host {
        agent: agent.clone(),
        socket: socket.clone(),
        channels: Mutex::new(HashMap::new()),
        closed: AtomicBool::new(false),
        last_received: AtomicU64::new(log::now_ms()),
    });
    {
        let host = host.clone();
        thread::spawn(move || heartbeat(&host));
    }
    let close = loop {
        let message = match socket.recv() {
            Ok(message) => message,
            Err(error) => break (1006, error.to_string()),
        };
        host.last_received.store(log::now_ms(), Ordering::SeqCst);
        match message {
            WsMessage::Text(text) => match serde_json::from_str::<Value>(text.as_str()) {
                Ok(control) => host.control(&control),
                Err(_) => {
                    socket.terminate();
                    break (1006, "invalid relay message".into());
                }
            },
            WsMessage::Binary(frame) => host.data(&frame),
            WsMessage::Close(frame) => break ws::close_of(&frame),
            _ => {}
        }
    };
    host.closed.store(true, Ordering::SeqCst);
    socket.terminate();
    // The relay fails every channel of a lost host; whatever is left here ends with it.
    let channels: Vec<Channel> = host
        .channels
        .lock()
        .unwrap()
        .drain()
        .map(|(_, channel)| channel)
        .collect();
    for channel in channels {
        channel.end();
    }
    close
}

/// Ping after HEARTBEAT_IDLE_MS of silence from the relay; cut the connection after HEARTBEAT_TIMEOUT_MS.
fn heartbeat(host: &Host) {
    let mut last_ping = 0u64;
    while !host.closed.load(Ordering::SeqCst) {
        thread::sleep(HEARTBEAT_TICK);
        let now = log::now_ms();
        let received = host.last_received.load(Ordering::SeqCst);
        // A backward clock step would otherwise stop pings and the timeout until it caught up.
        if now < received.max(last_ping) {
            host.last_received.store(now, Ordering::SeqCst);
            last_ping = now;
            continue;
        }
        if now - received >= HEARTBEAT_TIMEOUT_MS {
            log::line(&format!(
                "no message from the relay for {} s",
                (now - received) / 1000
            ));
            host.socket.terminate();
            return;
        }
        if now - received.max(last_ping) >= HEARTBEAT_IDLE_MS {
            last_ping = now;
            host.send_control(json!({ "version": PROTOCOL_VERSION, "type": "ping" }));
        }
    }
}

impl Channel {
    fn end(&self) {
        match self {
            Channel::Http(channel) => channel.end(),
            Channel::Sockets(sockets) => sockets.end(),
        }
    }
}

impl Host {
    fn control(self: &Arc<Self>, control: &Value) {
        let id = control["connection_id"].as_str().unwrap_or_default();
        match control["type"].as_str() {
            Some("ping") => {
                self.send_control(json!({ "version": PROTOCOL_VERSION, "type": "pong" }))
            }
            Some("connection_close") => {
                let channel = self.channels.lock().unwrap().remove(id);
                if let Some(channel) = channel {
                    channel.end();
                }
            }
            Some("credit") => {
                let channel = match self.channels.lock().unwrap().get(id) {
                    Some(Channel::Http(channel)) => Some(channel.clone()),
                    _ => None,
                };
                if let (Some(channel), Some(bytes)) = (channel, control["bytes"].as_u64()) {
                    channel.credit(bytes);
                }
            }
            Some("connection_open") if valid_connection_id(id) => self.open(id, control),
            _ => {}
        }
    }

    fn open(self: &Arc<Self>, id: &str, open: &Value) {
        let config = &self.agent.config;
        let principal = &open["principal"];
        let owner = principal["kind"] == "user"
            && principal["id"].as_str() == Some(&config.principal_id)
            && principal["organization_id"].as_str() == Some(&config.organization_id);
        let anonymous = principal.is_null();
        let kind = open["kind"].as_str().unwrap_or_default();
        let request = proxy::RequestHead::from_json(&open["request"]);
        let public_origin = open["public_origin"].as_str();
        match (kind, open["forward"].as_str()) {
            // A Pi client's channel: no browser request, no origin. A browser's WebSocket to the machine's own origin
            // carries both, and a page there must not get the owner's sessions.
            ("ws", None) if owner && open["request"].is_null() && public_origin.is_none() => {
                let sockets = Arc::new(Sockets::default());
                self.register(id, Channel::Sockets(sockets.clone()));
                channel::open(self.clone(), id.to_string(), sockets);
            }
            ("http" | "ws", Some(forward)) if owner || anonymous => {
                let (Some(request), Some(public_origin)) = (request, public_origin) else {
                    return self.refuse(id, Some(1008));
                };
                if !request.valid() {
                    return match kind {
                        "http" => self.respond_text(id, 400, proxy::INVALID_REQUEST),
                        _ => self.refuse(id, Some(1008)),
                    };
                }
                let forward = self
                    .agent
                    .forwards
                    .get(forward)
                    // An anonymous visitor learns nothing about forwards that are not public: they look unknown.
                    .filter(|forward| forward.public || !anonymous);
                let target = forward.map(|forward| proxy::Target {
                    port: forward.port,
                    public_origin: public_origin.to_string(),
                });
                if kind == "http" {
                    let window = open["window"].as_u64().unwrap_or(proxy::DEFAULT_WINDOW);
                    proxy::open_http(self, id, request, target, window);
                } else {
                    proxy::open_ws(self, id, request, target);
                }
            }
            ("http", None) if owner => self.respond_text(id, 404, OWNER_HTTP_TEXT),
            _ => self.refuse(id, Some(1008)),
        }
    }

    fn data(&self, frame: &[u8]) {
        if frame.len() < DATA_HEADER_BYTES || frame[0] != PROTOCOL_VERSION {
            return;
        }
        let id = format_uuid(&frame[2..DATA_HEADER_BYTES]);
        let channel = match self.channels.lock().unwrap().get(&id) {
            Some(Channel::Http(channel)) => Some(channel.clone()),
            _ => None,
        };
        if let Some(channel) = channel {
            channel.data(&frame[DATA_HEADER_BYTES..], frame[1]);
        }
    }

    /// Keep `channel` until it ends; one registered after the host closed ends at once.
    pub fn register(&self, id: &str, channel: Channel) {
        let mut channels = self.channels.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            drop(channels);
            return channel.end();
        }
        channels.insert(id.to_string(), channel);
    }

    /// Forget a channel that ended; whether it was still registered.
    pub fn remove(&self, id: &str) -> bool {
        self.channels.lock().unwrap().remove(id).is_some()
    }

    pub fn send_control(&self, control: Value) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if self
            .socket
            .send(WsMessage::text(control.to_string()))
            .is_err()
        {
            self.socket.terminate();
        }
    }

    /// A data frame of channel `id` on the host socket: binary, text or end of body.
    pub fn send_data(&self, id: &str, kind: u8, payload: &[u8]) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let mut frame = Vec::with_capacity(DATA_HEADER_BYTES + payload.len());
        frame.push(PROTOCOL_VERSION);
        frame.push(kind);
        frame.extend_from_slice(&parse_uuid(id));
        frame.extend_from_slice(payload);
        if self.socket.send(WsMessage::binary(frame)).is_err() {
            self.socket.terminate();
        }
    }

    /// Refuse or end channel `id` on the host socket.
    pub fn refuse(&self, id: &str, code: Option<u16>) {
        let mut control =
            json!({ "version": PROTOCOL_VERSION, "type": "connection_close", "connection_id": id });
        if let Some(code) = code {
            control["code"] = json!(code);
        }
        self.send_control(control);
    }

    /// A short plain-text response the agent makes up itself; well within any flow-control window.
    pub fn respond_text(&self, id: &str, status: u16, text: &str) {
        self.send_control(json!({
            "version": PROTOCOL_VERSION,
            "type": "response",
            "connection_id": id,
            "status": status,
            "headers": [["content-type", "text/plain; charset=utf-8"]],
        }));
        self.send_data(id, FRAME_BINARY, text.as_bytes());
        self.send_data(id, FRAME_END, &[]);
    }

    /// Open channel `id`'s own socket to the relay, with the current access token (refreshed once if refused).
    pub fn channel_socket(&self, id: &str) -> Result<Arc<Socket>, String> {
        let path = format!("/v1/servers/{}/channels/{id}", self.agent.config.server_id);
        let mut stale = None;
        loop {
            let token = match self.agent.tokens.access(stale.as_deref()) {
                Ok(token) => token,
                Err(TokenFailure::Replaced) => {
                    exit(&self.agent, "credentials.json changed: enrolled again", 0)
                }
                Err(failure) => return Err(failure.to_string()),
            };
            match open_socket(&self.agent, &path, CHANNEL_SUBPROTOCOL, &token) {
                Ok((socket, _)) => return Ok(socket),
                Err(ConnectError::Refused { status: 401, .. }) if stale.is_none() => {
                    stale = Some(token)
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

/// The access token, refreshed through the gateway as it nears expiry; one refresh at a time.
pub struct Tokens {
    state: State,
    gateway: Origin,
    credentials: Mutex<Credentials>,
    /// Held while a refresh runs, so the credentials stay readable meanwhile.
    refreshing: Mutex<()>,
}

/// Why no access token is available.
#[derive(Debug)]
pub enum TokenFailure {
    /// The gateway refused the refresh token: the machine was removed.
    Revoked(String),
    /// `credentials.json` no longer holds this agent's grant: the machine was enrolled again (or uninstalled).
    Replaced,
    Failed(String),
}

impl std::fmt::Display for TokenFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenFailure::Revoked(message) => write!(formatter, "revoked: {message}"),
            TokenFailure::Replaced => {
                formatter.write_str("credentials.json changed: enrolled again")
            }
            TokenFailure::Failed(message) => formatter.write_str(message),
        }
    }
}

impl Tokens {
    pub fn new(state: State, gateway: Origin, credentials: Credentials) -> Tokens {
        Tokens {
            state,
            gateway,
            credentials: Mutex::new(credentials),
            refreshing: Mutex::new(()),
        }
    }

    /// A current access token: refreshed when it expires within five minutes, or when it is `refused` (the gateway
    /// answered 401 for it). A failed refresh of a token that has not expired yet returns that token, and so does a
    /// caller that finds another one refreshing.
    pub fn access(&self, refused: Option<&str>) -> Result<String, TokenFailure> {
        let now = log::now_ms();
        let seen = self.credentials.lock().unwrap().clone();
        let refused = refused == Some(seen.access_token.as_str());
        if !refused && seen.expires_at > now + REFRESH_MARGIN_MS {
            return Ok(seen.access_token);
        }
        let _refreshing = match self.refreshing.try_lock() {
            Ok(guard) => guard,
            Err(_) if !refused && seen.expires_at > now => return Ok(seen.access_token),
            Err(_) => self.refreshing.lock().unwrap(),
        };
        let current = self.credentials.lock().unwrap().clone();
        if current.access_token != seen.access_token && current.expires_at > now + REFRESH_MARGIN_MS
        {
            // Another caller refreshed meanwhile.
            return Ok(current.access_token);
        }
        // A new enrollment may have replaced credentials.json; this older grant must not be written over it.
        let on_disk = self.state.credentials().map_err(TokenFailure::Failed)?;
        if on_disk.map(|disk| disk.refresh_token) != Some(current.refresh_token.clone()) {
            return Err(TokenFailure::Replaced);
        }
        match oauth::refresh(&self.gateway, &current.refresh_token) {
            Ok(grant) => {
                let refreshed = Credentials {
                    access_token: grant.access_token,
                    refresh_token: grant.refresh_token.unwrap_or(current.refresh_token),
                    expires_at: now + grant.expires_in * 1000,
                };
                if let Err(error) = self.state.write_credentials(&refreshed) {
                    log::line(&format!("writing credentials.json: {error}"));
                }
                *self.credentials.lock().unwrap() = refreshed.clone();
                Ok(refreshed.access_token)
            }
            Err(TokenError::Rejected(message)) => Err(TokenFailure::Revoked(message)),
            // Answers of enrollment only; a refresh never gets them.
            Err(error @ (TokenError::Claimed | TokenError::Mismatch(_))) => {
                Err(TokenFailure::Revoked(error.to_string()))
            }
            Err(error) if refused || current.expires_at <= now => Err(TokenFailure::Failed(
                format!("refreshing the access token: {error}"),
            )),
            Err(error) => {
                log::line(&format!("refreshing the access token: {error}"));
                Ok(current.access_token)
            }
        }
    }
}

fn valid_connection_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn format_uuid(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn parse_uuid(id: &str) -> [u8; 16] {
    let hex: Vec<u8> = id.bytes().filter(|byte| *byte != b'-').collect();
    let mut bytes = [0u8; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let pair = std::str::from_utf8(&hex[index * 2..index * 2 + 2]).unwrap_or("00");
        *byte = u8::from_str_radix(pair, 16).unwrap_or(0);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_connection_ids() {
        let id = "0123abcd-4567-4890-abcd-ef0123456789";
        assert!(valid_connection_id(id));
        assert!(!valid_connection_id("0123ABCD-4567-4890-abcd-ef0123456789"));
        assert_eq!(format_uuid(&parse_uuid(id)), id);
    }
}
