//! The agent's state directory (`~/.pi/env` by default): its enrollment (`agent.json`), its OAuth credentials
//! (`credentials.json`, owner-only), the relay status the running agent reports (`status.json`), and atomic writes.

use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// What `agent.json` holds: where and as whom this machine is enrolled, and the service `install` set up.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentConfig {
    pub gateway: String,
    pub server_id: String,
    pub organization_id: String,
    /// The owner: the only principal whose env channels the agent serves.
    pub principal_id: String,
    /// The row's cortex origin (`https://<label>.<domain>`), which forward URLs derive from.
    pub public_origin: Option<String>,
    pub name: Option<String>,
    pub service: Option<ServiceRecord>,
}

/// The user service `install` set up: its kind (`launchd`, ...) and its name (label, unit, task or script name).
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceRecord {
    pub kind: String,
    pub name: String,
}

/// The OAuth credentials of the machine's host grant; `expires_at` in milliseconds since the epoch.
#[derive(Clone, Debug, PartialEq)]
pub struct Credentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
}

/// The state directory and the files in it.
#[derive(Clone, Debug)]
pub struct State {
    pub dir: PathBuf,
}

impl State {
    /// `--state DIR`, else `~/.pi/env` (`%USERPROFILE%\.pi\env` on Windows).
    pub fn new(dir: Option<&str>) -> State {
        let dir = match dir {
            Some(dir) => absolute(Path::new(dir)),
            None => PathBuf::from(crate::sys::home()).join(".pi").join("env"),
        };
        State { dir }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// The binary `install` copies itself to, which the service runs.
    pub fn binary(&self) -> PathBuf {
        self.dir.join("bin").join(if cfg!(windows) {
            "pi-env.exe"
        } else {
            "pi-env"
        })
    }

    pub fn agent(&self) -> Result<Option<AgentConfig>, String> {
        let Some(value) = self.read_json("agent.json")? else {
            return Ok(None);
        };
        let text = |key: &str| value[key].as_str().map(str::to_string);
        let required = |key: &str| text(key).ok_or_else(|| format!("agent.json lacks {key}"));
        Ok(Some(AgentConfig {
            gateway: required("gateway")?,
            server_id: required("serverId")?,
            organization_id: required("organizationId")?,
            principal_id: required("principalId")?,
            public_origin: text("publicOrigin"),
            name: text("name"),
            service: match (
                value["service"]["kind"].as_str(),
                value["service"]["name"].as_str(),
            ) {
                (Some(kind), Some(name)) => Some(ServiceRecord {
                    kind: kind.to_string(),
                    name: name.to_string(),
                }),
                _ => None,
            },
        }))
    }

    pub fn write_agent(&self, config: &AgentConfig) -> Result<(), String> {
        let mut value = json!({
            "gateway": config.gateway,
            "serverId": config.server_id,
            "organizationId": config.organization_id,
            "principalId": config.principal_id,
            "publicOrigin": config.public_origin,
            "name": config.name,
        });
        if let Some(service) = &config.service {
            value["service"] = json!({ "kind": service.kind, "name": service.name });
        }
        self.write_json("agent.json", &value, false)
    }

    pub fn credentials(&self) -> Result<Option<Credentials>, String> {
        let Some(value) = self.read_json("credentials.json")? else {
            return Ok(None);
        };
        match (
            value["access_token"].as_str(),
            value["refresh_token"].as_str(),
            value["expires_at"].as_u64(),
        ) {
            (Some(access), Some(refresh), Some(expires_at)) => Ok(Some(Credentials {
                access_token: access.to_string(),
                refresh_token: refresh.to_string(),
                expires_at,
            })),
            _ => Err("credentials.json is incomplete".into()),
        }
    }

    pub fn write_credentials(&self, credentials: &Credentials) -> Result<(), String> {
        let value = json!({
            "access_token": credentials.access_token,
            "refresh_token": credentials.refresh_token,
            "expires_at": credentials.expires_at,
        });
        self.write_json("credentials.json", &value, true)
    }

    /// What the running agent last reported (`status.json`), if anything.
    pub fn status(&self) -> Option<Value> {
        self.read_json("status.json").ok().flatten()
    }

    pub fn write_status(&self, status: &Value) -> Result<(), String> {
        self.write_json("status.json", status, false)
    }

    pub fn read_json(&self, name: &str) -> Result<Option<Value>, String> {
        let path = self.path(name);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| format!("{}: {error}", path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }

    pub fn write_json(&self, name: &str, value: &Value, private: bool) -> Result<(), String> {
        let mut text = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        text.push(b'\n');
        write_atomic(&self.path(name), &text, private)
            .map_err(|error| format!("{}: {error}", self.path(name).display()))
    }
}

/// Write `bytes` to a temporary file beside `path` and rename it over `path`, so readers see the old or the new
/// content, never a part. `private` files are readable by their owner only.
pub fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    let result = (|| {
        let mut file: File = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_enrollment_and_keeps_credentials_private() {
        let dir = std::env::temp_dir().join(format!("pi-env-state-{}", std::process::id()));
        let state = State::new(Some(dir.to_str().unwrap()));
        assert_eq!(state.agent().unwrap(), None);
        let config = AgentConfig {
            gateway: "https://radius.example".into(),
            server_id: "s".into(),
            organization_id: "o".into(),
            principal_id: "p".into(),
            public_origin: Some("https://abc.rdtun.example".into()),
            name: None,
            service: Some(ServiceRecord {
                kind: "launchd".into(),
                name: "dev.pi.env".into(),
            }),
        };
        state.write_agent(&config).unwrap();
        assert_eq!(state.agent().unwrap(), Some(config));
        let credentials = Credentials {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 5,
        };
        state.write_credentials(&credentials).unwrap();
        assert_eq!(state.credentials().unwrap(), Some(credentials));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(state.path("credentials.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
