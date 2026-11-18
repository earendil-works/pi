//! A small HTTP/1.1 client: response heads, bodies by length, chunked or until close, and whole requests to the
//! gateway (OAuth). The forward proxy streams through the same head and body readers.

use super::net::{self, Origin};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::time::Duration;

/// Largest response head accepted.
const MAX_HEAD: usize = 64 * 1024;
const MAX_HEADERS: usize = 256;
/// Largest response body a gateway request reads.
const MAX_BODY: u64 = 4 * 1024 * 1024;

/// A response's status line and headers, as sent (names keep their case).
#[derive(Debug)]
pub struct Head {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl Head {
    /// The first header named `name`, compared without case.
    pub fn header(&self, name: &str) -> Option<&str> {
        header(&self.headers, name)
    }
}

/// The first of `headers` named `name`, compared without case.
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Read one response head; interim (1xx) responses other than 101 are skipped.
pub fn read_head(reader: &mut impl BufRead) -> io::Result<Head> {
    loop {
        let mut raw = Vec::new();
        while !raw.ends_with(b"\r\n\r\n") {
            if raw.len() >= MAX_HEAD {
                return Err(invalid("response head too large"));
            }
            let mut byte = [0u8];
            if reader.read(&mut byte)? == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed before a response",
                ));
            }
            raw.push(byte[0]);
        }
        let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut response = httparse::Response::new(&mut headers);
        match response.parse(&raw) {
            Ok(httparse::Status::Complete(_)) => {}
            _ => return Err(invalid("invalid response head")),
        }
        let status = response.code.unwrap_or(502);
        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        let headers = response
            .headers
            .iter()
            .map(|header| {
                (
                    header.name.to_string(),
                    String::from_utf8_lossy(header.value).into_owned(),
                )
            })
            .collect();
        return Ok(Head { status, headers });
    }
}

/// How a response body ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Framing {
    Empty,
    Length(u64),
    Chunked,
    UntilClose,
}

/// The framing of the response to a `method` request with `head` (RFC 9112, 6.3).
pub fn framing(method: &str, head: &Head) -> Framing {
    if method == "HEAD" || head.status == 204 || head.status == 304 || head.status < 200 {
        return Framing::Empty;
    }
    if head
        .header("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return Framing::Chunked;
    }
    match head
        .header("content-length")
        .and_then(|value| value.trim().parse().ok())
    {
        Some(length) => Framing::Length(length),
        None => Framing::UntilClose,
    }
}

/// A response body without its framing: the bytes the server meant, then end of file.
pub struct Body<R> {
    reader: R,
    framing: Framing,
    /// Bytes left in the body (`Length`) or in the current chunk (`Chunked`).
    remaining: u64,
    done: bool,
}

impl<R: BufRead> Body<R> {
    pub fn new(reader: R, framing: Framing) -> Body<R> {
        Body {
            reader,
            framing,
            remaining: match framing {
                Framing::Length(length) => length,
                _ => 0,
            },
            done: matches!(framing, Framing::Empty | Framing::Length(0)),
        }
    }

    fn line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(truncated());
        }
        Ok(line.trim_end().to_string())
    }
}

impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.done || buffer.is_empty() {
            return Ok(0);
        }
        if self.framing == Framing::Chunked && self.remaining == 0 {
            let line = self.line()?;
            let size = line.split(';').next().unwrap_or("").trim();
            self.remaining =
                u64::from_str_radix(size, 16).map_err(|_| invalid("invalid chunk size"))?;
            if self.remaining == 0 {
                // Trailers, up to the empty line.
                while !self.line()?.is_empty() {}
                self.done = true;
                return Ok(0);
            }
        }
        let limit = match self.framing {
            Framing::UntilClose => buffer.len(),
            _ => buffer.len().min(self.remaining as usize),
        };
        let read = self.reader.read(&mut buffer[..limit])?;
        if read == 0 {
            if self.framing == Framing::UntilClose {
                self.done = true;
                return Ok(0);
            }
            return Err(truncated());
        }
        if self.framing != Framing::UntilClose {
            self.remaining -= read as u64;
            if self.remaining == 0 {
                match self.framing {
                    Framing::Length(_) => self.done = true,
                    _ => {
                        self.line()?;
                    }
                }
            }
        }
        Ok(read)
    }
}

/// A complete response to a gateway request.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One request to `origin` with a complete body, read to its end; one connection per request.
pub fn request(
    origin: &Origin,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    timeout: Duration,
) -> io::Result<Response> {
    let mut stream = net::connect(origin, timeout)?;
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        origin.authority(),
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let head = read_head(&mut reader)?;
    let mut body = Vec::new();
    Body::new(reader, framing(method, &head))
        .take(MAX_BODY)
        .read_to_end(&mut body)?;
    Ok(Response {
        status: head.status,
        body,
    })
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn truncated() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "response body ended early")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(raw: &[u8], method: &str) -> (Head, Vec<u8>) {
        let mut reader = BufReader::new(raw);
        let head = read_head(&mut reader).unwrap();
        let mut bytes = Vec::new();
        Body::new(reader, framing(method, &head))
            .read_to_end(&mut bytes)
            .unwrap();
        (head, bytes)
    }

    #[test]
    fn reads_bodies_by_length_chunks_and_close() {
        let (head, bytes) = body(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef", "GET");
        assert_eq!((head.status, bytes.as_slice()), (200, &b"abc"[..]));
        let chunked =
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nX-A: b\r\n\r\n3;x=y\r\nabc\r\n2\r\nde\r\n0\r\nT: v\r\n\r\n";
        let (head, bytes) = body(chunked, "POST");
        assert_eq!((head.status, bytes.as_slice()), (201, &b"abcde"[..]));
        assert_eq!(head.header("x-a"), Some("b"));
        let (_, bytes) = body(b"HTTP/1.0 200 OK\r\n\r\nuntil close", "GET");
        assert_eq!(bytes, b"until close");
        let (_, bytes) = body(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n", "HEAD");
        assert!(bytes.is_empty());
        let mut reader = BufReader::new(&b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab"[..]);
        let head = read_head(&mut reader).unwrap();
        let mut bytes = Vec::new();
        assert!(
            Body::new(reader, framing("GET", &head))
                .read_to_end(&mut bytes)
                .is_err()
        );
    }
}
