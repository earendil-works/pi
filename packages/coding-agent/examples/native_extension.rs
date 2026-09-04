#![allow(missing_docs)]

use serde_json::{Value, json};
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input)?;
    let response = match request.get("type").and_then(Value::as_str) {
        Some("tool_call") => {
            json!({"content":[{"type":"text","text":"native extension result"}],"details":{},"added_tool_names":[],"terminate":false})
        }
        Some("command") => json!({"message":"hello from a Rust extension"}),
        _ => Value::Null,
    };
    println!("{response}");
    Ok(())
}
