//! WebSocket clients (tungstenite) that one thread reads while others write, without an async runtime.
//!
//! tungstenite's `WebSocket` is one state machine for both directions, so it sits behind a mutex. A reader must not
//! hold that mutex while it waits for data, or every writer would wait with it: the reader therefore waits on a clone
//! of the TCP socket with `peek`, which consumes nothing, and takes the mutex only to read what arrived, with the
//! socket switched to nonblocking mode for that moment. Writers write in blocking mode, so a slow uplink blocks them:
//! that is the backpressure toward the sources they relay.

use super::net::Stream;
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tungstenite::client::ClientRequestBuilder;
use tungstenite::handshake::HandshakeError;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::{Error, Message, WebSocket};

pub use tungstenite::Message as WsMessage;

/// Largest message either side carries; the relay's own limit is 32 MiB.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// How long a closed socket waits for the peer's close before it is cut.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// One WebSocket connection.
pub struct Socket {
    ws: Mutex<WebSocket<Stream>>,
    /// The same TCP socket, for waiting without the mutex and for cutting the connection.
    probe: TcpStream,
}

/// Why a WebSocket handshake failed.
#[derive(Debug)]
pub enum ConnectError {
    /// The server answered with an HTTP status instead of switching protocols.
    Refused {
        status: u16,
        body: String,
    },
    Failed(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Refused { status, body } => write!(formatter, "{status}: {body}"),
            ConnectError::Failed(message) => formatter.write_str(message),
        }
    }
}

/// Complete a client handshake for `url` over `stream`, offering `protocols` (none: no `Sec-WebSocket-Protocol`)
/// with extra `headers`. The stream's timeouts bound the handshake; afterwards reads and writes have none. Returns the
/// socket and the protocol the server chose.
pub fn connect(
    stream: Stream,
    url: &str,
    protocols: &[&str],
    headers: &[(String, String)],
) -> Result<(Socket, Option<String>), ConnectError> {
    let probe = stream
        .tcp()
        .try_clone()
        .map_err(|error| ConnectError::Failed(error.to_string()))?;
    let uri = url
        .parse()
        .map_err(|_| ConnectError::Failed(format!("invalid WebSocket URL {url}")))?;
    let mut request = ClientRequestBuilder::new(uri);
    for (name, value) in headers {
        request = request.with_header(name.as_str(), value.as_str());
    }
    for protocol in protocols {
        request = request.with_sub_protocol(*protocol);
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let (ws, response) =
        match tungstenite::client::client_with_config(request, stream, Some(config)) {
            Ok(done) => done,
            Err(HandshakeError::Failure(Error::Http(response))) => {
                let body = response
                    .body()
                    .as_deref()
                    .map(|body| String::from_utf8_lossy(&body[..body.len().min(200)]).into_owned())
                    .unwrap_or_default();
                return Err(ConnectError::Refused {
                    status: response.status().as_u16(),
                    body,
                });
            }
            Err(HandshakeError::Failure(error)) => {
                return Err(ConnectError::Failed(error.to_string()));
            }
            Err(HandshakeError::Interrupted(_)) => {
                return Err(ConnectError::Failed("WebSocket handshake timed out".into()));
            }
        };
    let tcp = ws.get_ref().tcp();
    let _ = tcp.set_read_timeout(None);
    let _ = tcp.set_write_timeout(None);
    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    Ok((
        Socket {
            ws: Mutex::new(ws),
            probe,
        },
        protocol,
    ))
}

impl Socket {
    /// The next message: data, a ping or pong (answered already), or the peer's close. Only one thread may read.
    pub fn recv(&self) -> Result<Message, Error> {
        loop {
            {
                let mut ws = self.ws.lock().unwrap();
                ws.get_ref().tcp().set_nonblocking(true)?;
                let result = ws.read();
                let restored = ws.get_ref().tcp().set_nonblocking(false);
                match result {
                    Ok(message) => {
                        restored?;
                        if matches!(message, Message::Close(_)) {
                            // tungstenite queued the reply to the close; send it.
                            let _ = ws.flush();
                        }
                        return Ok(message);
                    }
                    Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        restored?;
                        // Replies to pings queue while the socket would block.
                        let _ = ws.flush();
                    }
                    Err(error) => return Err(error),
                }
            }
            let mut byte = [0u8; 1];
            match self.probe.peek(&mut byte) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => return Err(Error::Io(error)),
            }
        }
    }

    /// Send one message, waiting while the connection does not take it.
    pub fn send(&self, message: Message) -> Result<(), Error> {
        self.ws.lock().unwrap().send(message)
    }

    /// Start the closing handshake with `code`; the connection is cut if the peer does not answer within 5 seconds.
    pub fn close(self: &Arc<Self>, code: u16, reason: &str) {
        {
            let mut ws = self.ws.lock().unwrap();
            let _ = ws.close(Some(CloseFrame {
                code: code.into(),
                reason: reason.into(),
            }));
            let _ = ws.flush();
        }
        let socket = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE_WAIT);
            if let Some(socket) = socket.upgrade() {
                socket.terminate();
            }
        });
    }

    /// Cut the connection at once: a waiting reader and blocked writers fail.
    pub fn terminate(&self) {
        let _ = self.probe.shutdown(Shutdown::Both);
    }

    /// Bound the wait of the next reads (`None`: wait forever); a read that waits longer fails.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) {
        let _ = self.probe.set_read_timeout(timeout);
    }
}

/// A close code one side reported, as one the other side may send (1005 and 1006 are never sent).
pub fn sendable_code(code: u16) -> u16 {
    if code == 1005 {
        return 1000;
    }
    let valid = ((1000..=1014).contains(&code) && code != 1004 && code != 1006)
        || (3000..=4999).contains(&code);
    if valid { code } else { 1011 }
}

/// The close code and reason of a received close message (1005 when it had none).
pub fn close_of(frame: &Option<CloseFrame>) -> (u16, String) {
    match frame {
        Some(frame) => (frame.code.into(), frame.reason.to_string()),
        None => (1005, String::new()),
    }
}
