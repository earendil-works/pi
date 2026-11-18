//! The forward proxy: channels from a forward's origin (`fwd--<label>--<id>`, or `pub--` for public forwards) go to
//! `localhost:<port>` of this machine, as if the browser had opened `http://localhost:<port>` itself, the way p2's
//! brain relays them (`#openForward` in `apps/p2/plugins/radius/brain.ts`):
//!
//! - `Host` is the local address, an `Origin` of the forward's public origin becomes the local one, and
//!   `X-Forwarded-Host` and `X-Forwarded-Proto` name the public origin; dev servers check the first two.
//! - A `Location` pointing at `http://localhost:<port>` or `http://127.0.0.1:<port>` points at the public origin.
//! - HTTP channels stay on the host socket with the relay's credit flow control: at most the window of response body
//!   bytes is unacknowledged, and request body bytes are credited once written to the local server.
//! - WebSocket channels get their own channel socket, piped to the local WebSocket, which is offered the client's
//!   first subprotocol.
//! - An unknown forward answers 404 (HTTP) or is refused; nothing listening on the port answers 502.

use super::http::{self, Body};
use super::net::{self, Stream};
use super::relay::{Channel, FRAME_BINARY, FRAME_END, Host, Sockets};
use super::ws::{self, Socket, WsMessage};
use serde_json::{Value, json};
use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

/// The relay's window for relays that do not state it in `connection_open`.
pub const DEFAULT_WINDOW: u64 = 256 * 1024;
/// Largest data frame of a response body.
const BODY_CHUNK: usize = 256 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
const UNKNOWN_FORWARD: &str = "This port forward does not exist (any more).\n";
pub const INVALID_REQUEST: &str = "This request cannot be passed on to the forwarded port.\n";
/// Request headers the proxy sets itself, or that belong to one hop only.
const DROPPED: &[&str] = &[
    "host",
    "connection",
    "upgrade",
    "content-length",
    "transfer-encoding",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "x-radius-shell-origin",
    // Client addresses the local server must not take from the browser.
    "forwarded",
    "x-forwarded-for",
    "x-real-ip",
];
/// Methods whose requests have no body unless they state its length.
const BODILESS: &[&str] = &["GET", "HEAD"];

/// A forward's request as `connection_open` describes it.
pub struct RequestHead {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
}

/// How the request body goes to the local server.
#[derive(Clone, Copy, Debug, PartialEq)]
enum BodyFraming {
    /// `Content-Length`: exactly this many bytes.
    Length(u64),
    Chunked,
    /// GET and HEAD without a length: no body at all.
    None,
}

impl RequestHead {
    /// Whether the head can be written as is: a method of capital letters, a path and header names of visible ASCII,
    /// header values without CR, LF or NUL, so nothing in it ends a line of the request early.
    pub fn valid(&self) -> bool {
        let token = |text: &str| {
            !text.is_empty()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        };
        (1..=16).contains(&self.method.len())
            && self.method.bytes().all(|byte| byte.is_ascii_uppercase())
            && self.path.bytes().all(|byte| (0x21..0x7f).contains(&byte))
            && self.headers.iter().all(|(name, value)| {
                token(name) && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0))
            })
    }

    /// The body's framing; `None` for conflicting or malformed `Content-Length` headers.
    fn framing(&self) -> Option<BodyFraming> {
        let mut lengths = self
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim());
        match lengths.next() {
            Some(length) => {
                let valid = !length.is_empty() && length.bytes().all(|byte| byte.is_ascii_digit());
                let parsed = length.parse().ok().filter(|_| valid)?;
                lengths
                    .all(|other| other == length)
                    .then_some(BodyFraming::Length(parsed))
            }
            None if BODILESS.contains(&self.method.as_str()) => Some(BodyFraming::None),
            None => Some(BodyFraming::Chunked),
        }
    }

    pub fn from_json(value: &Value) -> Option<RequestHead> {
        let headers = value["headers"]
            .as_array()?
            .iter()
            .map(|pair| Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string())))
            .collect::<Option<Vec<_>>>()?;
        Some(RequestHead {
            method: value["method"].as_str()?.to_string(),
            path: value["path"]
                .as_str()
                .filter(|path| path.starts_with('/'))?
                .to_string(),
            headers,
        })
    }
}

/// Where a forward channel goes: the forward's port, reached from `public_origin`.
pub struct Target {
    pub port: u16,
    pub public_origin: String,
}

/// An HTTP channel of a forward: request body frames from the relay, and the relay's credit for the response body.
pub struct HttpChannel {
    /// Request body chunks for the local server; `None` is the end of the body.
    body: Mutex<Option<Sender<Option<Vec<u8>>>>>,
    /// Response body bytes the relay still takes.
    credit: Mutex<u64>,
    credited: Condvar,
    ended: AtomicBool,
    local: Mutex<Option<TcpStream>>,
}

impl HttpChannel {
    /// A request body frame from the relay.
    pub fn data(&self, payload: &[u8], kind: u8) {
        if let Some(body) = self.body.lock().unwrap().as_ref() {
            let _ = body.send((kind != FRAME_END).then(|| payload.to_vec()));
        }
    }

    pub fn credit(&self, bytes: u64) {
        *self.credit.lock().unwrap() += bytes;
        self.credited.notify_all();
    }

    /// The relay ended the channel, or the host connection was lost: stop relaying.
    pub fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
        self.body.lock().unwrap().take();
        if let Some(local) = self.local.lock().unwrap().as_ref() {
            let _ = local.shutdown(Shutdown::Both);
        }
        self.credited.notify_all();
    }

    /// Take up to `wanted` bytes of credit, waiting for some; `None` once the channel ended.
    fn take_credit(&self, wanted: u64) -> Option<u64> {
        let mut credit = self.credit.lock().unwrap();
        while *credit == 0 && !self.ended.load(Ordering::SeqCst) {
            credit = self.credited.wait(credit).unwrap();
        }
        if self.ended.load(Ordering::SeqCst) {
            return None;
        }
        let taken = wanted.min(*credit);
        *credit -= taken;
        Some(taken)
    }
}

/// Relay HTTP channel `id` to `target` (`None`: an unknown forward, answered with 404).
pub fn open_http(
    host: &Arc<Host>,
    id: &str,
    request: RequestHead,
    target: Option<Target>,
    window: u64,
) {
    let Some(target) = target else {
        return host.respond_text(id, 404, UNKNOWN_FORWARD);
    };
    let (body, chunks) = mpsc::channel();
    let channel = Arc::new(HttpChannel {
        body: Mutex::new(Some(body)),
        credit: Mutex::new(window),
        credited: Condvar::new(),
        ended: AtomicBool::new(false),
        local: Mutex::new(None),
    });
    // Registered before the next relay message, which may be a body frame of this channel.
    host.register(id, Channel::Http(channel.clone()));
    let host = host.clone();
    let id = id.to_string();
    thread::spawn(move || {
        match relay_http(&host, &id, &channel, request, &target, chunks) {
            Ok(()) => host.send_data(&id, FRAME_END, &[]),
            Err(Failure::Invalid) => host.respond_text(&id, 400, INVALID_REQUEST),
            Err(Failure::BeforeResponse) if !channel.ended.load(Ordering::SeqCst) => {
                let text = format!(
                    "Nothing is listening on port {} of this machine.\n",
                    target.port
                );
                host.respond_text(&id, 502, &text);
            }
            Err(_) if !channel.ended.load(Ordering::SeqCst) => host.refuse(&id, None),
            Err(_) => {}
        }
        host.remove(&id);
        channel.end();
    });
}

/// Where an HTTP channel failed: before the local server answered, the proxy answers 502 itself; a request it cannot
/// pass on gets 400.
enum Failure {
    Invalid,
    BeforeResponse,
    AfterResponse,
}

fn relay_http(
    host: &Arc<Host>,
    id: &str,
    channel: &Arc<HttpChannel>,
    request: RequestHead,
    target: &Target,
    chunks: Receiver<Option<Vec<u8>>>,
) -> Result<(), Failure> {
    let before = |_| Failure::BeforeResponse;
    let framing = request.framing().ok_or(Failure::Invalid)?;
    let local = connect_local(target.port).map_err(before)?;
    // A slow response (a long poll) is fine; the relay ends a channel nobody waits for.
    local.set_read_timeout(None).map_err(before)?;
    local.set_write_timeout(None).map_err(before)?;
    *channel.local.lock().unwrap() = Some(local.try_clone().map_err(before)?);
    if channel.ended.load(Ordering::SeqCst) {
        return Err(Failure::AfterResponse);
    }
    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
    for (name, value) in local_headers(&request.headers, target) {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Host: localhost:{}\r\nConnection: close\r\n",
        target.port
    ));
    match framing {
        BodyFraming::Length(length) => head.push_str(&format!("Content-Length: {length}\r\n")),
        BodyFraming::Chunked => head.push_str("Transfer-Encoding: chunked\r\n"),
        BodyFraming::None => {}
    }
    head.push_str("\r\n");
    let mut writer = local.try_clone().map_err(before)?;
    writer.write_all(head.as_bytes()).map_err(before)?;
    {
        let channel = channel.clone();
        let credit = host_credit(host.clone(), id.to_string());
        let (host, id) = (host.clone(), id.to_string());
        thread::spawn(move || {
            if !write_body(writer, chunks, framing, &channel, credit)
                && !channel.ended.load(Ordering::SeqCst)
            {
                // A body that does not fit its framing ends the channel: nothing of it may reach the server as a
                // request of its own.
                channel.end();
                host.refuse(&id, None);
            }
        });
    }
    let mut reader = BufReader::new(local);
    let head = http::read_head(&mut reader).map_err(before)?;
    let headers: Vec<Value> = head
        .headers
        .iter()
        .map(|(name, value)| {
            let value = if name.eq_ignore_ascii_case("location") {
                rewrite_location(value, target)
            } else {
                value.clone()
            };
            json!([name, value])
        })
        .collect();
    host.send_control(json!({
        "version": 2,
        "type": "response",
        "connection_id": id,
        "status": head.status,
        "headers": headers,
    }));
    let mut body = Body::new(reader, http::framing(&request.method, &head));
    let mut buffer = vec![0u8; BODY_CHUNK];
    loop {
        let read = body.read(&mut buffer).map_err(|_| Failure::AfterResponse)?;
        if read == 0 {
            return Ok(());
        }
        let mut sent = 0;
        while sent < read {
            let taken = channel
                .take_credit((read - sent) as u64)
                .ok_or(Failure::AfterResponse)? as usize;
            host.send_data(id, FRAME_BINARY, &buffer[sent..sent + taken]);
            sent += taken;
        }
    }
}

/// Credit for request body bytes, sent to the relay once the local server took them.
fn host_credit(host: Arc<Host>, id: String) -> impl Fn(usize) + Send {
    move |bytes| {
        host.send_control(
            json!({ "version": 2, "type": "credit", "connection_id": id, "bytes": bytes }),
        );
    }
}

/// Write the request body to the local server as it arrives, crediting the relay for each chunk. False when the body
/// broke its framing: bytes beyond `Content-Length`, an end before it, or any body of a GET or HEAD without one.
fn write_body(
    mut writer: TcpStream,
    chunks: Receiver<Option<Vec<u8>>>,
    framing: BodyFraming,
    channel: &HttpChannel,
    credit: impl Fn(usize),
) -> bool {
    let mut remaining = match framing {
        BodyFraming::Length(length) => length,
        _ => 0,
    };
    for chunk in chunks {
        let written = match (chunk, framing) {
            (Some(bytes), _) if bytes.is_empty() => Ok(()),
            (Some(bytes), BodyFraming::Chunked) => writer
                .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
                .and_then(|()| writer.write_all(&bytes))
                .and_then(|()| writer.write_all(b"\r\n"))
                .map(|()| credit(bytes.len())),
            (Some(bytes), BodyFraming::Length(_)) if bytes.len() as u64 <= remaining => {
                remaining -= bytes.len() as u64;
                writer.write_all(&bytes).map(|()| credit(bytes.len()))
            }
            (Some(_), _) => return false,
            (None, BodyFraming::Chunked) => {
                let _ = writer.write_all(b"0\r\n\r\n");
                return true;
            }
            (None, _) => return remaining == 0,
        };
        if written.is_err() || channel.ended.load(Ordering::SeqCst) {
            return true;
        }
    }
    true
}

/// Relay WebSocket channel `id` to `target` (`None`: an unknown forward, refused).
pub fn open_ws(host: &Arc<Host>, id: &str, request: RequestHead, target: Option<Target>) {
    let Some(target) = target else {
        return host.refuse(id, Some(1008));
    };
    let sockets = Arc::new(Sockets::default());
    host.register(id, Channel::Sockets(sockets.clone()));
    let host = host.clone();
    let id = id.to_string();
    thread::spawn(move || {
        // Until the channel socket is connected the relay waits for it: a failure is refused on the host socket,
        // which fails the client's upgrade at once.
        let Some((local, channel)) = open_pair(&host, &id, &request, &target, &sockets) else {
            host.refuse(&id, Some(1011));
            host.remove(&id);
            return sockets.end();
        };
        let upward = {
            let (from, to) = (local.clone(), channel.clone());
            thread::spawn(move || pipe(&from, &to))
        };
        pipe(&channel, &local);
        let _ = upward.join();
        host.remove(&id);
        sockets.end();
    });
}

fn open_pair(
    host: &Host,
    id: &str,
    request: &RequestHead,
    target: &Target,
    sockets: &Sockets,
) -> Option<(Arc<Socket>, Arc<Socket>)> {
    // The connect timeout stays through the handshake; until then the channel can only cut the raw stream.
    let tcp = connect_local(target.port).ok()?;
    if !sockets.add_stream(&tcp) {
        return None;
    }
    let protocol = http::header(&request.headers, "sec-websocket-protocol")
        .and_then(|offered| {
            offered
                .split(',')
                .map(str::trim)
                .find(|protocol| !protocol.is_empty())
        })
        .map(str::to_string);
    let headers: Vec<(String, String)> = local_headers(&request.headers, target)
        .into_iter()
        .filter(|(name, _)| !name.to_ascii_lowercase().starts_with("sec-websocket-"))
        .collect();
    let url = format!("ws://localhost:{}{}", target.port, request.path);
    let protocols: Vec<&str> = protocol.iter().map(String::as_str).collect();
    let (local, _) = ws::connect(Stream::Plain(tcp), &url, &protocols, &headers).ok()?;
    let local = Arc::new(local);
    if !sockets.add(&local) {
        return None;
    }
    let channel = host.channel_socket(id).ok()?;
    if !sockets.add(&channel) {
        return None;
    }
    Some((local, channel))
}

/// Pass `from`'s messages to `to` unchanged until `from` closes, then close `to` with the same code.
fn pipe(from: &Arc<Socket>, to: &Arc<Socket>) {
    loop {
        match from.recv() {
            Ok(message @ (WsMessage::Text(_) | WsMessage::Binary(_))) => {
                if to.send(message).is_err() {
                    return from.close(1011, "");
                }
            }
            Ok(WsMessage::Close(frame)) => {
                let (code, reason) = ws::close_of(&frame);
                return to.close(ws::sendable_code(code), &reason);
            }
            Ok(_) => {}
            Err(_) => return to.close(1011, ""),
        }
    }
}

/// A connection to `localhost:<port>`: IPv4 first, then IPv6, as dev servers listen on either. Reads and writes time
/// out after LOCAL_TIMEOUT until the caller clears it.
fn connect_local(port: u16) -> std::io::Result<TcpStream> {
    let addresses = [
        SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    net::connect_any(&addresses, LOCAL_TIMEOUT)
}

/// The request's headers for the local server (see the module comment); `Host` and framing are added by the caller.
fn local_headers(headers: &[(String, String)], target: &Target) -> Vec<(String, String)> {
    let local_origin = format!("http://localhost:{}", target.port);
    let (scheme, public_host) = target
        .public_origin
        .split_once("://")
        .unwrap_or(("https", &target.public_origin));
    let mut result: Vec<(String, String)> = headers
        .iter()
        .filter(|(name, _)| {
            let name = name.to_ascii_lowercase();
            !DROPPED.contains(&name.as_str())
                && name != "x-forwarded-host"
                && name != "x-forwarded-proto"
        })
        .map(|(name, value)| {
            if name.eq_ignore_ascii_case("origin") && *value == target.public_origin {
                (name.clone(), local_origin.clone())
            } else {
                (name.clone(), value.clone())
            }
        })
        .collect();
    result.push(("X-Forwarded-Host".into(), public_host.to_string()));
    result.push(("X-Forwarded-Proto".into(), scheme.to_string()));
    result
}

/// A `Location` to the local address, pointing at the public origin instead.
fn rewrite_location(value: &str, target: &Target) -> String {
    for prefix in [
        format!("http://localhost:{}", target.port),
        format!("http://127.0.0.1:{}", target.port),
    ] {
        if let Some(rest) = value.strip_prefix(&prefix)
            && (rest.is_empty() || rest.starts_with('/') || rest.starts_with('?'))
        {
            return format!("{}{rest}", target.public_origin);
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target {
            port: 5173,
            public_origin: "https://fwd--abc--x1.rdtun.example".into(),
        }
    }

    fn head(method: &str, path: &str, headers: &[(&str, &str)]) -> RequestHead {
        RequestHead {
            method: method.into(),
            path: path.into(),
            headers: headers
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        }
    }

    #[test]
    fn checks_heads_and_frames_bodies() {
        assert!(head("GET", "/a?b=%20", &[("X-A", "b c")]).valid());
        assert!(!head("GET", "/a b", &[]).valid());
        assert!(!head("get", "/", &[]).valid());
        assert!(!head("GET", "/", &[("X-A", "b\r\nC: d")]).valid());
        assert!(!head("GET", "/", &[("X A", "b")]).valid());
        assert!(!head("GET", "/", &[("X-A", "b\0")]).valid());
        assert_eq!(head("GET", "/", &[]).framing(), Some(BodyFraming::None));
        assert_eq!(head("HEAD", "/", &[]).framing(), Some(BodyFraming::None));
        assert_eq!(
            head("DELETE", "/", &[]).framing(),
            Some(BodyFraming::Chunked)
        );
        assert_eq!(
            head(
                "GET",
                "/",
                &[("content-length", "3"), ("Content-Length", "3")]
            )
            .framing(),
            Some(BodyFraming::Length(3))
        );
        assert_eq!(
            head(
                "POST",
                "/",
                &[("content-length", "3"), ("content-length", "4")]
            )
            .framing(),
            None
        );
        assert_eq!(
            head("POST", "/", &[("content-length", "+3")]).framing(),
            None
        );
    }

    #[test]
    fn rewrites_local_locations_only() {
        let target = target();
        assert_eq!(
            rewrite_location("http://localhost:5173/a?b", &target),
            "https://fwd--abc--x1.rdtun.example/a?b"
        );
        assert_eq!(
            rewrite_location("http://127.0.0.1:5173", &target),
            "https://fwd--abc--x1.rdtun.example"
        );
        assert_eq!(
            rewrite_location("http://localhost:51730/", &target),
            "http://localhost:51730/"
        );
        assert_eq!(rewrite_location("/relative", &target), "/relative");
    }

    #[test]
    fn rewrites_origin_and_adds_forwarded_headers() {
        let headers = vec![
            (
                "Origin".to_string(),
                "https://fwd--abc--x1.rdtun.example".to_string(),
            ),
            ("Host".to_string(), "fwd--abc--x1.rdtun.example".to_string()),
            ("X-Forwarded-Host".to_string(), "elsewhere".to_string()),
            ("Cookie".to_string(), "a=b".to_string()),
        ];
        let local = local_headers(&headers, &target());
        assert_eq!(
            local,
            vec![
                ("Origin".to_string(), "http://localhost:5173".to_string()),
                ("Cookie".to_string(), "a=b".to_string()),
                (
                    "X-Forwarded-Host".to_string(),
                    "fwd--abc--x1.rdtun.example".to_string()
                ),
                ("X-Forwarded-Proto".to_string(), "https".to_string()),
            ]
        );
    }
}
