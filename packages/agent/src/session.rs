use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use pi_ai::{Message, ThinkingLevel, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

pub const SESSION_VERSION: u32 = 3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "legacy_session_version")]
    pub version: u32,
    pub id: String,
    pub timestamp: String,
    pub cwd: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub timestamp: String,
    #[serde(flatten)]
    pub data: SessionEntryData,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SessionEntryData {
    Message {
        message: Message,
    },
    ModelChange {
        provider: String,
        model_id: String,
    },
    ThinkingLevelChange {
        thinking_level: ThinkingLevel,
    },
    Compaction {
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        first_kept_entry_id: Option<String>,
        tokens_before: u64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        retained_tail: Vec<Message>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default)]
        from_hook: bool,
    },
    BranchSummary {
        from_id: String,
        summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
        #[serde(default)]
        from_hook: bool,
    },
    Custom {
        custom_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
    },
    CustomMessage {
        custom_type: String,
        content: Value,
        display: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
    },
    Label {
        target_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    SessionInfo {
        name: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuiltSessionContext {
    pub messages: Vec<Message>,
    pub model: Option<(String, String)>,
    pub thinking_level: Option<ThinkingLevel>,
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid session JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session is empty")]
    Empty,
    #[error("invalid session header")]
    InvalidHeader,
    #[error("unknown session entry: {0}")]
    UnknownEntry(String),
    #[error("entry {0} is not in this session")]
    UnknownId(String),
}

pub struct SessionManager {
    header: SessionHeader,
    entries: Vec<SessionEntry>,
    leaf_id: Option<String>,
    file: Option<PathBuf>,
    session_dir: Option<PathBuf>,
}

impl SessionManager {
    pub async fn create(cwd: impl Into<PathBuf>, session_dir: impl Into<PathBuf>) -> Result<Self, SessionError> {
        let cwd = cwd.into();
        let session_dir = session_dir.into().join(encode_cwd(&cwd));
        fs::create_dir_all(&session_dir).await?;
        let id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now();
        let file = session_dir.join(format!("{}_{}.jsonl", timestamp.format("%Y-%m-%dT%H-%M-%S-%3fZ"), id));
        let header = SessionHeader {
            kind: "session".into(),
            version: SESSION_VERSION,
            id,
            timestamp: timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            cwd,
            parent_session: None,
        };
        let mut manager = Self {
            header,
            entries: Vec::new(),
            leaf_id: None,
            file: Some(file),
            session_dir: Some(session_dir),
        };
        manager.rewrite().await?;
        Ok(manager)
    }

    #[must_use]
    pub fn in_memory(cwd: impl Into<PathBuf>) -> Self {
        Self {
            header: SessionHeader {
                kind: "session".into(),
                version: SESSION_VERSION,
                id: Uuid::new_v4().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                cwd: cwd.into(),
                parent_session: None,
            },
            entries: Vec::new(),
            leaf_id: None,
            file: None,
            session_dir: None,
        }
    }

    pub async fn open(path: impl Into<PathBuf>) -> Result<Self, SessionError> {
        let file = path.into();
        let text = fs::read_to_string(&file).await?;
        let mut lines = text.lines();
        let header_line = lines.next().ok_or(SessionError::Empty)?;
        let mut header: SessionHeader = serde_json::from_str(header_line)?;
        if header.kind != "session" {
            return Err(SessionError::InvalidHeader);
        }
        let mut entries: Vec<SessionEntry> = Vec::new();
        let mut legacy_parent = None;
        for line in lines.filter(|line| !line.trim().is_empty()) {
            let value: Value = serde_json::from_str(line)?;
            let entry = serde_json::from_value::<SessionEntry>(value.clone()).unwrap_or_else(|_| {
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(short_id);
                let timestamp = value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                let kind = value
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                let data = value
                    .get("message")
                    .cloned()
                    .and_then(|message| serde_json::from_value(message).ok())
                    .map_or_else(
                        || SessionEntryData::Custom {
                            custom_type: format!("legacy:{kind}"),
                            data: Some(value),
                        },
                        |message| SessionEntryData::Message { message },
                    );
                SessionEntry {
                    id,
                    parent_id: legacy_parent.clone(),
                    timestamp,
                    data,
                }
            });
            legacy_parent = Some(entry.id.clone());
            entries.push(entry);
        }
        header.version = SESSION_VERSION;
        let leaf_id = entries.last().map(|entry| entry.id.clone());
        let session_dir = file.parent().map(Path::to_owned);
        Ok(Self {
            header,
            entries,
            leaf_id,
            file: Some(file),
            session_dir,
        })
    }

    pub async fn continue_recent(
        cwd: impl Into<PathBuf>,
        session_root: impl Into<PathBuf>,
    ) -> Result<Self, SessionError> {
        let cwd = cwd.into();
        let directory = session_root.into().join(encode_cwd(&cwd));
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        if let Ok(mut entries) = fs::read_dir(&directory).await {
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let modified = entry.metadata().await?.modified()?;
                if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                    newest = Some((modified, path));
                }
            }
        }
        if let Some((_, path)) = newest {
            Self::open(path).await
        } else {
            Self::create(cwd, directory.parent().unwrap_or(&directory)).await
        }
    }

    pub async fn list(cwd: &Path, session_root: &Path) -> Result<Vec<SessionHeader>, SessionError> {
        let directory = session_root.join(encode_cwd(cwd));
        let mut result = Vec::new();
        let Ok(mut entries) = fs::read_dir(directory).await else {
            return Ok(result);
        };
        while let Some(entry) = entries.next_entry().await? {
            if entry.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(entry.path()).await
                && let Some(line) = text.lines().next()
                && let Ok(header) = serde_json::from_str(line)
            {
                result.push(header)
            }
        }
        result.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(result)
    }

    pub async fn append(&mut self, data: SessionEntryData) -> Result<String, SessionError> {
        let id = short_id();
        let entry = SessionEntry {
            id: id.clone(),
            parent_id: self.leaf_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            data,
        };
        if let Some(file) = &self.file {
            let mut output = fs::OpenOptions::new().create(true).append(true).open(file).await?;
            output.write_all(serde_json::to_string(&entry)?.as_bytes()).await?;
            output.write_all(b"\n").await?;
            output.flush().await?;
        }
        self.entries.push(entry);
        self.leaf_id = Some(id.clone());
        Ok(id)
    }
    pub async fn append_message(&mut self, message: Message) -> Result<String, SessionError> {
        self.append(SessionEntryData::Message { message }).await
    }
    pub async fn append_model_change(
        &mut self,
        provider: impl Into<String>,
        model_id: impl Into<String>,
    ) -> Result<String, SessionError> {
        self.append(SessionEntryData::ModelChange {
            provider: provider.into(),
            model_id: model_id.into(),
        })
        .await
    }
    pub async fn append_thinking_level_change(
        &mut self,
        thinking_level: ThinkingLevel,
    ) -> Result<String, SessionError> {
        self.append(SessionEntryData::ThinkingLevelChange { thinking_level })
            .await
    }
    pub async fn append_session_info(&mut self, name: impl Into<String>) -> Result<String, SessionError> {
        self.append(SessionEntryData::SessionInfo { name: name.into() }).await
    }
    pub async fn append_label_change(
        &mut self,
        target_id: impl Into<String>,
        label: Option<String>,
    ) -> Result<String, SessionError> {
        self.append(SessionEntryData::Label {
            target_id: target_id.into(),
            label,
        })
        .await
    }

    #[must_use]
    pub fn header(&self) -> &SessionHeader {
        &self.header
    }
    #[must_use]
    pub fn entries(&self) -> &[SessionEntry] {
        &self.entries
    }
    #[must_use]
    pub fn leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }
    #[must_use]
    pub fn leaf_entry(&self) -> Option<&SessionEntry> {
        self.leaf_id.as_deref().and_then(|id| self.get_entry(id))
    }
    #[must_use]
    pub fn get_entry(&self, id: &str) -> Option<&SessionEntry> {
        self.entries.iter().find(|entry| entry.id == id)
    }
    #[must_use]
    pub fn get_children(&self, parent_id: Option<&str>) -> Vec<&SessionEntry> {
        self.entries
            .iter()
            .filter(|entry| entry.parent_id.as_deref() == parent_id)
            .collect()
    }
    #[must_use]
    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }
    #[must_use]
    pub fn session_dir(&self) -> Option<&Path> {
        self.session_dir.as_deref()
    }
    #[must_use]
    pub fn is_persisted(&self) -> bool {
        self.file.is_some()
    }
    #[must_use]
    pub fn session_name(&self) -> Option<&str> {
        self.active_path().iter().rev().find_map(|entry| match &entry.data {
            SessionEntryData::SessionInfo { name } => Some(name.as_str()),
            _ => None,
        })
    }
    #[must_use]
    pub fn label(&self, target_id: &str) -> Option<&str> {
        self.active_path().iter().rev().find_map(|entry| match &entry.data {
            SessionEntryData::Label { target_id: id, label } if id == target_id => label.as_deref(),
            _ => None,
        })
    }

    pub fn branch(&mut self, id: &str) -> Result<(), SessionError> {
        if self.get_entry(id).is_none() {
            return Err(SessionError::UnknownId(id.into()));
        }
        self.leaf_id = Some(id.into());
        Ok(())
    }
    pub fn reset_leaf(&mut self) {
        self.leaf_id = None;
    }

    #[must_use]
    pub fn active_path(&self) -> Vec<&SessionEntry> {
        let by_id = self
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect::<HashMap<_, _>>();
        let mut path = Vec::new();
        let mut current = self.leaf_id.as_deref();
        while let Some(id) = current {
            let Some(entry) = by_id.get(id).copied() else { break };
            path.push(entry);
            current = entry.parent_id.as_deref();
        }
        path.reverse();
        path
    }

    #[must_use]
    pub fn build_context(&self) -> BuiltSessionContext {
        let mut result = BuiltSessionContext::default();
        for entry in self.active_path() {
            match &entry.data {
                SessionEntryData::Message { message } => result.messages.push(message.clone()),
                SessionEntryData::ModelChange { provider, model_id } => {
                    result.model = Some((provider.clone(), model_id.clone()))
                }
                SessionEntryData::ThinkingLevelChange { thinking_level } => {
                    result.thinking_level = Some(*thinking_level)
                }
                SessionEntryData::Compaction {
                    summary, retained_tail, ..
                } => {
                    result.messages.clear();
                    result
                        .messages
                        .push(Message::user(format!("Conversation summary:\n{summary}")));
                    result.messages.extend(retained_tail.clone());
                }
                _ => {}
            }
        }
        result
    }

    pub async fn create_branched_session(&self, leaf_id: &str, target_root: &Path) -> Result<Self, SessionError> {
        let entry = self
            .get_entry(leaf_id)
            .ok_or_else(|| SessionError::UnknownId(leaf_id.into()))?;
        let mut ids = Vec::new();
        let mut current = Some(entry);
        while let Some(item) = current {
            ids.push(item.id.clone());
            current = item.parent_id.as_deref().and_then(|id| self.get_entry(id));
        }
        ids.reverse();
        let mut target = Self::create(self.header.cwd.clone(), target_root).await?;
        target.header.parent_session = self.file.clone();
        target.entries = self
            .entries
            .iter()
            .filter(|entry| ids.contains(&entry.id))
            .cloned()
            .collect();
        target.leaf_id = Some(leaf_id.into());
        target.rewrite().await?;
        Ok(target)
    }

    async fn rewrite(&mut self) -> Result<(), SessionError> {
        if let Some(file) = &self.file {
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).await?
            }
            let mut text = serde_json::to_string(&self.header)?;
            text.push('\n');
            for entry in &self.entries {
                text.push_str(&serde_json::to_string(entry)?);
                text.push('\n');
            }
            fs::write(file, text).await?
        }
        Ok(())
    }
}

const fn legacy_session_version() -> u32 {
    1
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_owned()
}

#[must_use]
pub fn encode_cwd(cwd: &Path) -> String {
    let value = cwd.to_string_lossy().replace(['/', '\\'], "-");
    format!("--{}--", value.trim_matches('-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn branches_without_losing_entries() {
        let mut session = SessionManager::in_memory("/tmp/demo");
        let first = session.append_message(Message::user("one")).await.unwrap();
        let second = session.append_message(Message::user("two")).await.unwrap();
        session.branch(&first).unwrap();
        let third = session.append_message(Message::user("three")).await.unwrap();
        assert_eq!(session.entries().len(), 3);
        assert_eq!(session.get_children(Some(&first)).len(), 2);
        assert_eq!(session.active_path().last().unwrap().id, third);
        assert_ne!(second, third);
    }
}
