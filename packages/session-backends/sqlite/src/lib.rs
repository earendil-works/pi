#![allow(missing_docs)]
//! SQLite-backed durable sessions for Pi.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::Engine;
use parking_lot::Mutex;
use pi_agent_core::{SESSION_VERSION, SessionEntry, SessionEntryData, SessionHeader};
use pi_ai::Message;
use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;
use uuid::Uuid;

const MIGRATION: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,parent_session TEXT);
CREATE TABLE IF NOT EXISTS branches(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,name TEXT NOT NULL,parent_branch_id TEXT,head_entry_id TEXT,created_at TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS branches_name ON branches(session_id,name);
CREATE TABLE IF NOT EXISTS entries(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,branch_id TEXT NOT NULL,parent_id TEXT,timestamp TEXT NOT NULL,data_json TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,FOREIGN KEY(branch_id) REFERENCES branches(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS entries_session_sequence ON entries(session_id,sequence);
"#;

#[derive(Debug, Error)]
pub enum SqliteSessionError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("session already has a writable owner: {0}")]
    AlreadyOpen(String),
    #[error("branch not found: {0}")]
    BranchNotFound(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionMetadata {
    pub id: String,
    pub cwd: PathBuf,
    pub path: PathBuf,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct SqliteSessionRepo {
    directory: PathBuf,
    database_path: Option<PathBuf>,
    open: Arc<Mutex<HashSet<String>>>,
}
impl SqliteSessionRepo {
    pub fn new(directory: impl Into<PathBuf>) -> Result<Self, SqliteSessionError> {
        let directory = directory.into();
        std::fs::create_dir_all(&directory)?;
        Ok(Self {
            directory,
            database_path: None,
            open: Arc::new(Mutex::new(HashSet::new())),
        })
    }
    pub fn shared(database_path: impl Into<PathBuf>) -> Result<Self, SqliteSessionError> {
        let database_path = database_path.into();
        if let Some(parent) = database_path.parent() {
            std::fs::create_dir_all(parent)?
        }
        Ok(Self {
            directory: database_path.parent().unwrap_or(Path::new(".")).to_owned(),
            database_path: Some(database_path),
            open: Arc::new(Mutex::new(HashSet::new())),
        })
    }
    fn path_for(&self, id: &str) -> PathBuf {
        self.database_path
            .clone()
            .unwrap_or_else(|| self.directory.join(format!("{}.sqlite", encode_session_id(id))))
    }
    pub fn create(&self, cwd: impl Into<PathBuf>) -> Result<SqliteSession, SqliteSessionError> {
        self.create_with_id(Uuid::new_v4().to_string(), cwd.into())
    }
    pub fn create_with_id(&self, id: String, cwd: PathBuf) -> Result<SqliteSession, SqliteSessionError> {
        self.acquire(&id)?;
        let path = self.path_for(&id);
        let result = (|| {
            let connection = Connection::open(&path)?;
            connection.execute_batch(MIGRATION)?;
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            connection.execute(
                "INSERT INTO sessions(id,cwd,created_at,updated_at) VALUES(?1,?2,?3,?3)",
                params![id, cwd.to_string_lossy(), now],
            )?;
            Ok(SqliteSession {
                metadata: SessionMetadata {
                    id: id.clone(),
                    cwd,
                    path,
                    created_at: now.clone(),
                    updated_at: now,
                },
                connection: Arc::new(Mutex::new(connection)),
                open: self.open.clone(),
            })
        })();
        if result.is_err() {
            self.open.lock().remove(&id);
        }
        result
    }
    pub fn open(&self, id: &str) -> Result<SqliteSession, SqliteSessionError> {
        self.acquire(id)?;
        let path = self.path_for(id);
        let result = (|| {
            if !path.exists() {
                return Err(SqliteSessionError::NotFound(id.into()));
            }
            let connection = Connection::open(&path)?;
            connection.execute_batch(MIGRATION)?;
            let metadata = connection
                .query_row(
                    "SELECT id,cwd,created_at,updated_at FROM sessions WHERE id=?1",
                    [id],
                    |row| {
                        Ok(SessionMetadata {
                            id: row.get(0)?,
                            cwd: PathBuf::from(row.get::<_, String>(1)?),
                            path: path.clone(),
                            created_at: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()?
                .ok_or_else(|| SqliteSessionError::NotFound(id.into()))?;
            Ok(SqliteSession {
                metadata,
                connection: Arc::new(Mutex::new(connection)),
                open: self.open.clone(),
            })
        })();
        if result.is_err() {
            self.open.lock().remove(id);
        }
        result
    }
    fn acquire(&self, id: &str) -> Result<(), SqliteSessionError> {
        if !self.open.lock().insert(id.into()) {
            return Err(SqliteSessionError::AlreadyOpen(id.into()));
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<SessionMetadata>, SqliteSessionError> {
        if let Some(path) = &self.database_path {
            return list_database(path);
        }
        let mut result = Vec::new();
        for entry in std::fs::read_dir(&self.directory)? {
            let path = entry?.path();
            if path.extension().and_then(|x| x.to_str()) == Some("sqlite") {
                result.extend(list_database(&path).unwrap_or_default())
            }
        }
        result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(result)
    }
    pub fn delete(&self, id: &str) -> Result<(), SqliteSessionError> {
        if self.open.lock().contains(id) {
            return Err(SqliteSessionError::AlreadyOpen(id.into()));
        }
        let path = self.path_for(id);
        if self.database_path.is_some() {
            let connection = Connection::open(path)?;
            connection.execute("DELETE FROM sessions WHERE id=?1", [id])?;
        } else if path.exists() {
            std::fs::remove_file(path)?
        }
        Ok(())
    }
    pub fn fork(
        &self,
        source: &SessionMetadata,
        target_id: String,
        target_cwd: PathBuf,
    ) -> Result<SqliteSession, SqliteSessionError> {
        let target = self.create_with_id(target_id, target_cwd)?;
        let source_connection = Connection::open_with_flags(&source.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let entries = read_entries(&source_connection, &source.id, None)?;
        let branch = target.create_branch("main", None)?;
        for entry in entries {
            target.append_entry(&branch, entry.data)?;
        }
        Ok(target)
    }
}

fn list_database(path: &Path) -> Result<Vec<SessionMetadata>, SqliteSessionError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement =
        connection.prepare("SELECT id,cwd,created_at,updated_at FROM sessions ORDER BY updated_at DESC")?;
    let rows = statement.query_map([], |row| {
        Ok(SessionMetadata {
            id: row.get(0)?,
            cwd: PathBuf::from(row.get::<_, String>(1)?),
            path: path.to_owned(),
            created_at: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Branch {
    pub id: String,
    pub name: String,
    pub parent_branch_id: Option<String>,
    pub head_entry_id: Option<String>,
}
pub struct SqliteSession {
    metadata: SessionMetadata,
    connection: Arc<Mutex<Connection>>,
    open: Arc<Mutex<HashSet<String>>>,
}
impl SqliteSession {
    #[must_use]
    pub fn metadata(&self) -> &SessionMetadata {
        &self.metadata
    }
    pub fn create_branch(&self, name: &str, parent: Option<&Branch>) -> Result<Branch, SqliteSessionError> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let head = parent.and_then(|branch| branch.head_entry_id.clone());
        self.connection.lock().execute("INSERT INTO branches(id,session_id,name,parent_branch_id,head_entry_id,created_at) VALUES(?1,?2,?3,?4,?5,?6)",params![id,self.metadata.id,name,parent.map(|b|&b.id),head,now])?;
        Ok(Branch {
            id,
            name: name.into(),
            parent_branch_id: parent.map(|b| b.id.clone()),
            head_entry_id: head,
        })
    }
    pub fn branch(&self, name: &str) -> Result<Branch, SqliteSessionError> {
        self.connection
            .lock()
            .query_row(
                "SELECT id,name,parent_branch_id,head_entry_id FROM branches WHERE session_id=?1 AND name=?2",
                params![self.metadata.id, name],
                |row| {
                    Ok(Branch {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        parent_branch_id: row.get(2)?,
                        head_entry_id: row.get(3)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| SqliteSessionError::BranchNotFound(name.into()))
    }
    pub fn append_message(&self, branch: &Branch, message: Message) -> Result<String, SqliteSessionError> {
        self.append_entry(branch, SessionEntryData::Message { message })
    }
    pub fn append_entry(&self, branch: &Branch, data: SessionEntryData) -> Result<String, SqliteSessionError> {
        let id = Uuid::new_v4().simple().to_string()[..8].to_owned();
        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let parent: Option<String> = transaction
            .query_row(
                "SELECT head_entry_id FROM branches WHERE id=?1 AND session_id=?2",
                params![branch.id, self.metadata.id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        transaction.execute(
            "INSERT INTO entries(id,session_id,branch_id,parent_id,timestamp,data_json) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                id,
                self.metadata.id,
                branch.id,
                parent,
                timestamp,
                serde_json::to_string(&data)?
            ],
        )?;
        transaction.execute(
            "UPDATE branches SET head_entry_id=?1 WHERE id=?2",
            params![id, branch.id],
        )?;
        transaction.execute(
            "UPDATE sessions SET updated_at=?1 WHERE id=?2",
            params![timestamp, self.metadata.id],
        )?;
        transaction.commit()?;
        Ok(id)
    }
    pub fn entries(&self, branch: Option<&Branch>) -> Result<Vec<SessionEntry>, SqliteSessionError> {
        read_entries(
            &self.connection.lock(),
            &self.metadata.id,
            branch.map(|branch| branch.id.as_str()),
        )
    }
    #[must_use]
    pub fn header(&self) -> SessionHeader {
        SessionHeader {
            kind: "session".into(),
            version: SESSION_VERSION,
            id: self.metadata.id.clone(),
            timestamp: self.metadata.created_at.clone(),
            cwd: self.metadata.cwd.clone(),
            parent_session: None,
        }
    }
}
impl Drop for SqliteSession {
    fn drop(&mut self) {
        self.open.lock().remove(&self.metadata.id);
    }
}

fn read_entries(
    connection: &Connection,
    session_id: &str,
    branch_id: Option<&str>,
) -> Result<Vec<SessionEntry>, SqliteSessionError> {
    let mut entries = Vec::new();
    if let Some(branch_id) = branch_id {
        let mut statement=connection.prepare("SELECT id,parent_id,timestamp,data_json FROM entries WHERE session_id=?1 AND branch_id=?2 ORDER BY sequence")?;
        let rows = statement.query_map(params![session_id, branch_id], decode_entry)?;
        for row in rows {
            entries.push(row?)
        }
    } else {
        let mut statement = connection
            .prepare("SELECT id,parent_id,timestamp,data_json FROM entries WHERE session_id=?1 ORDER BY sequence")?;
        let rows = statement.query_map([session_id], decode_entry)?;
        for row in rows {
            entries.push(row?)
        }
    }
    Ok(entries)
}
fn decode_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionEntry> {
    let json: String = row.get(3)?;
    let data = serde_json::from_str(&json)
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(SessionEntry {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        timestamp: row.get(2)?,
        data,
    })
}

#[must_use]
pub fn encode_session_id(id: &str) -> String {
    if !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return id.into();
    }
    let utf16 = id.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    format!("~{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(utf16))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_ids_are_encoded() {
        assert_eq!(encode_session_id("safe-ID_1"), "safe-ID_1");
        assert!(encode_session_id("a/b").starts_with('~'));
    }
    #[test]
    fn persists_messages() {
        let path = std::env::temp_dir().join(format!("pi-sqlite-test-{}", Uuid::new_v4()));
        let repo = SqliteSessionRepo::new(&path).unwrap();
        let session = repo.create("/tmp").unwrap();
        let id = session.metadata().id.clone();
        let branch = session.create_branch("main", None).unwrap();
        session.append_message(&branch, Message::user("hello")).unwrap();
        assert_eq!(session.entries(Some(&branch)).unwrap().len(), 1);
        drop(session);
        assert_eq!(repo.open(&id).unwrap().entries(None).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(path);
    }
}
