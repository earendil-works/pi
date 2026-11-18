//! The agent's port forwards (`forwards.json`) and the operations env channels manage them with: `forwards`,
//! `forwardSet` and `forwardRemove` (docs/agent.md). The forward proxy looks forwards up here for every request.

use super::state::write_atomic;
use crate::errors::Failure;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;

/// At most this many forwards, as p2 allows.
const MAX_FORWARDS: usize = 50;
const MAX_NAME: usize = 40;
const ID_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH: usize = 10;

/// One forward: `port` of this machine, reachable at its own origin beside the machine's.
#[derive(Clone, Debug, PartialEq)]
pub struct Forward {
    pub id: String,
    pub port: u16,
    pub name: Option<String>,
    /// Also open to anyone, without signing in, at its public origin.
    pub public: bool,
    /// The opener's own label, such as `{"p2": …, "session": …}`; forwards are removed by it.
    pub tag: Option<Value>,
}

/// The forwards, in memory and written through to `forwards.json`.
pub struct Forwards {
    path: PathBuf,
    /// The machine's cortex origin, `https://<label>.<domain>`, which forward origins derive from.
    origin: Option<String>,
    list: Mutex<Vec<Forward>>,
}

impl Forwards {
    /// The forwards saved at `path` (none if it does not exist).
    pub fn open(path: PathBuf, origin: Option<String>) -> Result<Forwards, String> {
        let list = match std::fs::read(&path) {
            Ok(bytes) => parse(&bytes).map_err(|error| format!("{}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        Ok(Forwards {
            path,
            origin,
            list: Mutex::new(list),
        })
    }

    pub fn get(&self, id: &str) -> Option<Forward> {
        self.list
            .lock()
            .unwrap()
            .iter()
            .find(|forward| forward.id == id)
            .cloned()
    }

    /// Run one of the forward operations of an env channel.
    pub fn handle(&self, op: &str, json: &Value) -> Result<Value, Failure> {
        match op {
            "forwards" => {
                let list = self.list.lock().unwrap();
                let views: Vec<Value> = list.iter().map(|forward| self.view(forward)).collect();
                Ok(json!({ "origin": self.origin, "forwards": views }))
            }
            "forwardSet" => self
                .set(json)
                .map(|forward| json!({ "forward": self.view(&forward) })),
            _ => self
                .remove(json)
                .map(|removed| json!({ "removed": removed })),
        }
    }

    fn set(&self, json: &Value) -> Result<Forward, Failure> {
        let port = json["port"]
            .as_u64()
            .filter(|port| (1..=65535).contains(port))
            .ok_or_else(|| Failure::new("EINVAL", "port must be a number from 1 to 65535"))?
            as u16;
        let name = match &json["name"] {
            Value::Null => None,
            value => Some(validate_name(value)?),
        };
        let public = match &json["public"] {
            Value::Null => None,
            Value::Bool(public) => Some(*public),
            _ => return Err(Failure::new("EINVAL", "public must be a boolean")),
        };
        let tag = match &json["tag"] {
            Value::Null => None,
            tag => Some(tag.clone()),
        };
        let mut list = self.list.lock().unwrap();
        let existing = match json["id"].as_str() {
            Some(id) => Some(
                list.iter()
                    .position(|forward| forward.id == id)
                    .ok_or_else(|| Failure::new("ENOENT", format!("no forward {id}")))?,
            ),
            // An open without ID is idempotent: the same port and tag update the forward they opened before.
            None => list
                .iter()
                .position(|forward| forward.port == port && forward.tag == tag),
        };
        let forward = match existing {
            Some(index) => {
                let forward = &mut list[index];
                forward.port = port;
                if let Some(name) = name {
                    forward.name = name;
                }
                if let Some(public) = public {
                    forward.public = public;
                }
                if json["id"].is_string() && !json["tag"].is_null() {
                    forward.tag = tag;
                }
                forward.clone()
            }
            None => {
                if list.len() >= MAX_FORWARDS {
                    return Err(Failure::new(
                        "EINVAL",
                        format!("at most {MAX_FORWARDS} forwards"),
                    ));
                }
                let forward = Forward {
                    id: new_id(&list),
                    port,
                    name: name.flatten(),
                    public: public.unwrap_or(false),
                    tag,
                };
                list.push(forward.clone());
                forward
            }
        };
        self.save(&list)?;
        Ok(forward)
    }

    fn remove(&self, json: &Value) -> Result<usize, Failure> {
        let mut list = self.list.lock().unwrap();
        let before = list.len();
        match (json["id"].as_str(), &json["tag"]) {
            (Some(id), _) => list.retain(|forward| forward.id != id),
            (None, Value::Null) => {
                return Err(Failure::new("EINVAL", "forwardRemove needs id or tag"));
            }
            (None, tag) => list.retain(|forward| forward.tag.as_ref() != Some(tag)),
        }
        let removed = before - list.len();
        if removed > 0 {
            self.save(&list)?;
        }
        Ok(removed)
    }

    fn save(&self, list: &[Forward]) -> Result<(), Failure> {
        let forwards: Vec<Value> = list.iter().map(stored).collect();
        let mut text = serde_json::to_vec_pretty(&json!({ "forwards": forwards }))
            .map_err(|error| Failure::new("EIO", error.to_string()))?;
        text.push(b'\n');
        write_atomic(&self.path, &text, false)
            .map_err(|error| Failure::io(&error, "write", &self.path.to_string_lossy()))
    }

    fn view(&self, forward: &Forward) -> Value {
        let mut value = stored(forward);
        value["public"] = json!(forward.public);
        if let Some(origin) = &self.origin {
            if let Some(url) = forward_origin(origin, &forward.id, "fwd") {
                value["url"] = json!(url);
            }
            if forward.public
                && let Some(url) = forward_origin(origin, &forward.id, "pub")
            {
                value["publicUrl"] = json!(url);
            }
        }
        value
    }
}

/// A forward's origin beside the machine's `https://<label>.<domain>`: `https://<prefix>--<label>--<id>.<domain>`.
pub fn forward_origin(origin: &str, id: &str, prefix: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    let (label, domain) = rest.split_once('.')?;
    Some(format!("{scheme}://{prefix}--{label}--{id}.{domain}"))
}

fn stored(forward: &Forward) -> Value {
    let mut value = json!({ "id": forward.id, "port": forward.port });
    if let Some(name) = &forward.name {
        value["name"] = json!(name);
    }
    if forward.public {
        value["public"] = json!(true);
    }
    if let Some(tag) = &forward.tag {
        value["tag"] = tag.clone();
    }
    value
}

fn parse(bytes: &[u8]) -> Result<Vec<Forward>, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let entries = value["forwards"]
        .as_array()
        .ok_or("forwards.json lacks forwards")?;
    entries
        .iter()
        .map(|entry| {
            let id = entry["id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("invalid forward id")?;
            let port = entry["port"]
                .as_u64()
                .filter(|port| (1..=65535).contains(port))
                .ok_or("invalid forward port")?;
            Ok(Forward {
                id: id.to_string(),
                port: port as u16,
                name: entry["name"].as_str().map(str::to_string),
                public: entry["public"].as_bool().unwrap_or(false),
                tag: match &entry["tag"] {
                    Value::Null => None,
                    tag => Some(tag.clone()),
                },
            })
        })
        .collect()
}

/// A name of at most 40 characters without control characters; blank clears it (`Some(None)`).
fn validate_name(value: &Value) -> Result<Option<String>, Failure> {
    let invalid = || {
        Failure::new(
            "EINVAL",
            format!("names have at most {MAX_NAME} characters"),
        )
    };
    let name = value.as_str().ok_or_else(invalid)?;
    if name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(invalid());
    }
    let name = name.trim();
    Ok((!name.is_empty()).then(|| name.to_string()))
}

fn valid_id(id: &str) -> bool {
    (1..=24).contains(&id.len()) && id.bytes().all(|byte| ID_ALPHABET.contains(&byte))
}

fn new_id(list: &[Forward]) -> String {
    loop {
        let id: String = super::random_bytes(ID_LENGTH)
            .iter()
            .map(|byte| ID_ALPHABET[*byte as usize % ID_ALPHABET.len()] as char)
            .collect();
        if !list.iter().any(|forward| forward.id == id) {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forwards(name: &str) -> Forwards {
        let path = std::env::temp_dir().join(format!(
            "pi-env-forwards-{name}-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        Forwards::open(path, Some("https://0123abcd.rdtun.example".into())).unwrap()
    }

    #[test]
    fn opens_idempotently_by_port_and_tag_and_removes_by_tag() {
        let store = forwards("tags");
        let tag = json!({ "p2": "i", "session": "s" });
        let first = store
            .handle("forwardSet", &json!({ "port": 5173, "tag": tag }))
            .unwrap();
        let id = first["forward"]["id"].as_str().unwrap().to_string();
        assert!(id.len() == 10 && valid_id(&id));
        assert_eq!(
            first["forward"]["url"],
            json!(format!("https://fwd--0123abcd--{id}.rdtun.example"))
        );
        assert!(first["forward"]["publicUrl"].is_null());
        let again = store
            .handle(
                "forwardSet",
                &json!({ "port": 5173, "tag": tag, "public": true, "name": "vite" }),
            )
            .unwrap();
        assert_eq!(again["forward"]["id"], json!(id));
        assert_eq!(
            again["forward"]["publicUrl"],
            json!(format!("https://pub--0123abcd--{id}.rdtun.example"))
        );
        let other = store
            .handle("forwardSet", &json!({ "port": 5173 }))
            .unwrap();
        assert_ne!(other["forward"]["id"], json!(id));
        let reopened = Forwards::open(store.path.clone(), None).unwrap();
        assert_eq!(reopened.get(&id).unwrap().name.as_deref(), Some("vite"));
        let removed = store
            .handle("forwardRemove", &json!({ "tag": tag }))
            .unwrap();
        assert_eq!(removed, json!({ "removed": 1 }));
        let list = store.handle("forwards", &json!({})).unwrap();
        assert_eq!(list["forwards"].as_array().unwrap().len(), 1);
        assert_eq!(list["origin"], json!("https://0123abcd.rdtun.example"));
        std::fs::remove_file(&store.path).unwrap();
    }

    #[test]
    fn validates_ports_names_and_the_limit() {
        let store = forwards("limits");
        assert_eq!(
            store
                .handle("forwardSet", &json!({ "port": 0 }))
                .unwrap_err()
                .code,
            "EINVAL"
        );
        assert_eq!(
            store
                .handle("forwardSet", &json!({ "port": 1, "name": "x".repeat(41) }))
                .unwrap_err()
                .code,
            "EINVAL"
        );
        assert_eq!(
            store
                .handle("forwardSet", &json!({ "port": 1, "id": "nope" }))
                .unwrap_err()
                .code,
            "ENOENT"
        );
        for port in 1..=50 {
            store
                .handle("forwardSet", &json!({ "port": port }))
                .unwrap();
        }
        assert!(store.handle("forwardSet", &json!({ "port": 51 })).is_err());
        assert_eq!(
            store.handle("forwardRemove", &json!({})).unwrap_err().code,
            "EINVAL"
        );
        std::fs::remove_file(&store.path).unwrap();
    }
}
