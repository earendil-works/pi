//! Length-prefixed frames: `u32 length | u8 type | u32 id | u32 jsonLength | json | payload` (docs/protocol.md).

use serde_json::Value;
use std::io::{self, Read, Write};

pub const REQUEST: u8 = 1;
pub const RESULT: u8 = 2;
pub const ERROR: u8 = 3;
pub const EVENT: u8 = 4;
pub const CANCEL: u8 = 5;
pub const PING: u8 = 6;

/// Largest frame either side accepts.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// Largest payload a response carries, leaving room for its JSON.
pub const MAX_PAYLOAD: usize = MAX_FRAME - 64 * 1024;

pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub json: Value,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: u8, id: u32, json: Value) -> Frame {
        Frame {
            kind,
            id,
            json,
            payload: Vec::new(),
        }
    }

    pub fn with_payload(kind: u8, id: u32, json: Value, payload: Vec<u8>) -> Frame {
        Frame {
            kind,
            id,
            json,
            payload,
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Read one frame; `None` at a clean end of input.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(length) as usize;
    if !(9..=MAX_FRAME).contains(&length) {
        return Err(invalid("frame length out of range"));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    let kind = body[0];
    let id = u32::from_be_bytes([body[1], body[2], body[3], body[4]]);
    let json_length = u32::from_be_bytes([body[5], body[6], body[7], body[8]]) as usize;
    if 9 + json_length > length {
        return Err(invalid("JSON length out of range"));
    }
    // Unparseable JSON leaves the framing intact: the frame arrives with `Value::Null` and gets an error reply.
    let json = if json_length == 0 {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&body[9..9 + json_length]).unwrap_or(Value::Null)
    };
    let payload = body[9 + json_length..].to_vec();
    Ok(Some(Frame {
        kind,
        id,
        json,
        payload,
    }))
}

pub fn write_frame(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let json = serde_json::to_vec(&frame.json).map_err(|_| invalid("unserializable JSON"))?;
    let length = 9 + json.len() + frame.payload.len();
    if length > MAX_FRAME {
        return Err(invalid("frame too large"));
    }
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(length as u32).to_be_bytes());
    header.push(frame.kind);
    header.extend_from_slice(&frame.id.to_be_bytes());
    header.extend_from_slice(&(json.len() as u32).to_be_bytes());
    output.write_all(&header)?;
    output.write_all(&json)?;
    output.write_all(&frame.payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_json_and_payload() {
        let mut buffer = Vec::new();
        write_frame(
            &mut buffer,
            &Frame::with_payload(RESULT, 7, json!({ "a": 1 }), vec![0, 255, 10]),
        )
        .unwrap();
        let frame = read_frame(&mut buffer.as_slice()).unwrap().unwrap();
        assert_eq!((frame.kind, frame.id), (RESULT, 7));
        assert_eq!(frame.json, json!({ "a": 1 }));
        assert_eq!(frame.payload, vec![0, 255, 10]);
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
    }
}
