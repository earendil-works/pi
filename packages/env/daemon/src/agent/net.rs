//! Gateway addresses and connections to them: TCP, with TLS (rustls with ring and Mozilla's root certificates) for
//! `https` gateways. `http` gateways are for local development and tests.

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::Duration;

/// A gateway's origin: `http(s)://host[:port]`; paths are absolute below it.
#[derive(Clone, Debug, PartialEq)]
pub struct Origin {
    pub secure: bool,
    /// The host name, or an IP address (IPv6 without brackets).
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// Parse `http(s)://host[:port]`, ignoring a trailing `/`; anything else is refused.
    pub fn parse(text: &str) -> Result<Origin, String> {
        let invalid = || format!("invalid gateway URL {text:?}: use https://host[:port]");
        let (secure, rest) = if let Some(rest) = text.strip_prefix("https://") {
            (true, rest)
        } else if let Some(rest) = text.strip_prefix("http://") {
            (false, rest)
        } else {
            return Err(invalid());
        };
        let authority = rest.trim_end_matches('/');
        if authority.is_empty() || authority.contains(['/', '?', '#', '@', ' ']) {
            return Err(invalid());
        }
        let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
            let (host, after) = bracketed.split_once(']').ok_or_else(invalid)?;
            (host, after.strip_prefix(':'))
        } else {
            match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            }
        };
        let port = match port {
            Some(port) => port.parse::<u16>().map_err(|_| invalid())?,
            None if secure => 443,
            None => 80,
        };
        if host.is_empty() {
            return Err(invalid());
        }
        Ok(Origin {
            secure,
            host: host.to_ascii_lowercase(),
            port,
        })
    }

    /// `host[:port]` as the `Host` header names it; the scheme's default port is left out.
    pub fn authority(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == if self.secure { 443 } else { 80 } {
            host
        } else {
            format!("{host}:{}", self.port)
        }
    }

    /// The origin as text, `https://host[:port]`.
    pub fn text(&self) -> String {
        format!(
            "{}://{}",
            if self.secure { "https" } else { "http" },
            self.authority()
        )
    }

    /// The WebSocket URL of `path` (with query) on this origin.
    pub fn ws_url(&self, path: &str) -> String {
        format!(
            "{}://{}{path}",
            if self.secure { "wss" } else { "ws" },
            self.authority()
        )
    }
}

/// A connection to a gateway or a local port: plain TCP, or TLS over it.
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Stream {
    /// The TCP socket below, for timeouts, nonblocking mode and shutdown.
    pub fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(tcp) => tcp,
            Stream::Tls(tls) => &tls.sock,
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(tcp) => tcp.read(buffer),
            Stream::Tls(tls) => tls.read(buffer),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(tcp) => tcp.write(buffer),
            Stream::Tls(tls) => tls.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(tcp) => tcp.flush(),
            Stream::Tls(tls) => tls.flush(),
        }
    }
}

/// Connect to `origin` within `timeout` per address, and complete the TLS handshake for `https`. Reads and writes
/// keep `timeout` as their timeout until the caller changes it.
pub fn connect(origin: &Origin, timeout: Duration) -> io::Result<Stream> {
    let tcp = connect_any(&resolve(origin, timeout)?, timeout)?;
    if !origin.secure {
        return Ok(Stream::Plain(tcp));
    }
    let name = ServerName::try_from(origin.host.clone())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid host name"))?;
    let connection = ClientConnection::new(tls_config(), name).map_err(io::Error::other)?;
    let mut tls = StreamOwned::new(connection, tcp);
    while tls.conn.is_handshaking() {
        tls.conn.complete_io(&mut tls.sock)?;
    }
    Ok(Stream::Tls(Box::new(tls)))
}

/// The addresses of `origin`'s host, within `timeout`: the system resolver has none of its own, so it runs on a thread
/// that is left behind when it takes longer.
fn resolve(origin: &Origin, timeout: Duration) -> io::Result<Vec<SocketAddr>> {
    let (host, port) = (origin.host.clone(), origin.port);
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(
            (host.as_str(), port)
                .to_socket_addrs()
                .map(Iterator::collect),
        );
    });
    receiver.recv_timeout(timeout).unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "resolving the host name timed out",
        ))
    })
}

/// The first of `addresses` that accepts a connection, with `timeout` for each and as read and write timeout.
pub fn connect_any(addresses: &[SocketAddr], timeout: Duration) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no address");
    for address in addresses {
        match TcpStream::connect_timeout(address, timeout) {
            Ok(tcp) => {
                tcp.set_read_timeout(Some(timeout))?;
                tcp.set_write_timeout(Some(timeout))?;
                tcp.set_nodelay(true)?;
                return Ok(tcp);
            }
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let config = ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gateway_origins() {
        let origin = Origin::parse("https://Radius.pi.dev/").unwrap();
        assert_eq!(
            origin,
            Origin {
                secure: true,
                host: "radius.pi.dev".into(),
                port: 443
            }
        );
        assert_eq!(origin.text(), "https://radius.pi.dev");
        assert_eq!(origin.ws_url("/v1/x?a=1"), "wss://radius.pi.dev/v1/x?a=1");
        let local = Origin::parse("http://127.0.0.1:8787").unwrap();
        assert_eq!(local.authority(), "127.0.0.1:8787");
        assert_eq!(local.ws_url("/"), "ws://127.0.0.1:8787/");
        assert_eq!(
            Origin::parse("http://[::1]:9").unwrap().authority(),
            "[::1]:9"
        );
        assert!(Origin::parse("ftp://x").is_err());
        assert!(Origin::parse("https://x/path").is_err());
        assert!(Origin::parse("https://x:99999").is_err());
    }
}
