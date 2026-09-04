#![allow(missing_docs)]
//! Chord application composition, context, service, and replicated-state primitives.

use std::{any::Any, collections::HashMap, future::Future, sync::Arc};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub type JsonValue = Value;

#[must_use]
pub fn is_json_value(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Array(items) => items.iter().all(is_json_value),
        Value::Object(object) => object.values().all(is_json_value),
        _ => true,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ContextKey(&'static str);

#[must_use]
pub const fn create_context_key(description: &'static str) -> ContextKey {
    ContextKey(description)
}

#[derive(Clone, Default)]
pub struct Context {
    name: &'static str,
    values: Arc<HashMap<ContextKey, Arc<dyn Any + Send + Sync>>>,
    cancellation: Option<CancellationToken>,
}

impl Context {
    #[must_use]
    pub fn background() -> Self {
        Self {
            name: "[Context BACKGROUND_CONTEXT]",
            ..Self::default()
        }
    }

    #[must_use]
    pub fn todo() -> Self {
        Self {
            name: "[Context TODO_CONTEXT]",
            ..Self::default()
        }
    }

    #[must_use]
    pub fn value<T: Any + Send + Sync>(&self, key: &ContextKey) -> Option<Arc<T>> {
        self.values.get(key).cloned()?.downcast().ok()
    }

    #[must_use]
    pub fn with_value<T: Any + Send + Sync>(&self, key: ContextKey, value: T) -> Self {
        let mut values = (*self.values).clone();
        values.insert(key, Arc::new(value));
        Self {
            name: self.name,
            values: Arc::new(values),
            cancellation: self.cancellation.clone(),
        }
    }

    #[must_use]
    pub fn with_cancel(&self) -> (Self, CancellationToken) {
        let token = self
            .cancellation
            .as_ref()
            .map_or_else(CancellationToken::new, CancellationToken::child_token);
        let context = Self {
            name: self.name,
            values: self.values.clone(),
            cancellation: Some(token.clone()),
        };
        (context, token)
    }

    #[must_use]
    pub fn without_cancel(&self) -> Self {
        Self {
            name: self.name,
            values: self.values.clone(),
            cancellation: None,
        }
    }

    pub async fn cancelled(&self) {
        if let Some(token) = &self.cancellation {
            token.cancelled().await;
        } else {
            std::future::pending::<()>().await;
        }
    }

    pub async fn wait<T>(&self, future: impl Future<Output = T>) -> Result<T, ContextCancelled> {
        if let Some(token) = &self.cancellation {
            if token.is_cancelled() {
                return Err(ContextCancelled);
            }
            tokio::select! {
                value = future => Ok(value),
                () = token.cancelled() => Err(ContextCancelled),
            }
        } else {
            Ok(future.await)
        }
    }
}

impl std::fmt::Display for Context {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.name)
    }
}

#[derive(Debug, Error)]
#[error("the operation was cancelled")]
pub struct ContextCancelled;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Segment {
    Key(String),
    Index(usize),
}

pub type Path = Vec<Segment>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Replace {
        value: Value,
    },
    Set {
        path: Path,
        value: Value,
    },
    Delete {
        path: Path,
    },
    Append {
        path: Path,
        text: String,
    },
    TruncateFront {
        path: Path,
        count: usize,
    },
    Splice {
        path: Path,
        index: usize,
        remove: usize,
        items: Vec<Value>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathRef {
    Inline(Path),
    Id(u64),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WireOp {
    Replace {
        value: Value,
    },
    Define {
        id: u64,
        path: Path,
    },
    Set {
        path: Option<PathRef>,
        value: Value,
    },
    Delete {
        path: Option<PathRef>,
    },
    Append {
        path: Option<PathRef>,
        text: String,
    },
    TruncateFront {
        path: Option<PathRef>,
        count: usize,
    },
    Splice {
        path: Option<PathRef>,
        index: usize,
        remove: usize,
        items: Vec<Value>,
    },
}

#[derive(Default)]
pub struct DeltaEncoder {
    seen: std::collections::HashSet<Path>,
    ids: HashMap<Path, u64>,
    next_id: u64,
}
impl DeltaEncoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn encode(&mut self, ops: &[Op]) -> Vec<WireOp> {
        let mut output = Vec::new();
        let mut previous: Option<Path> = None;
        for op in ops {
            if let Op::Replace { value } = op {
                output.push(WireOp::Replace { value: value.clone() });
                self.seen.clear();
                self.ids.clear();
                self.next_id = 0;
                previous = None;
                continue;
            }
            let path = match op {
                Op::Set { path, .. }
                | Op::Delete { path }
                | Op::Append { path, .. }
                | Op::TruncateFront { path, .. }
                | Op::Splice { path, .. } => path,
                Op::Replace { .. } => unreachable!(),
            };
            let reference = if previous.as_ref() == Some(path) {
                None
            } else if let Some(id) = self.ids.get(path) {
                Some(PathRef::Id(*id))
            } else if self.seen.contains(path) {
                let id = self.next_id;
                self.next_id += 1;
                self.ids.insert(path.clone(), id);
                output.push(WireOp::Define { id, path: path.clone() });
                Some(PathRef::Id(id))
            } else {
                self.seen.insert(path.clone());
                Some(PathRef::Inline(path.clone()))
            };
            output.push(match op {
                Op::Set { value, .. } => WireOp::Set {
                    path: reference,
                    value: value.clone(),
                },
                Op::Delete { .. } => WireOp::Delete { path: reference },
                Op::Append { text, .. } => WireOp::Append {
                    path: reference,
                    text: text.clone(),
                },
                Op::TruncateFront { count, .. } => WireOp::TruncateFront {
                    path: reference,
                    count: *count,
                },
                Op::Splice {
                    index, remove, items, ..
                } => WireOp::Splice {
                    path: reference,
                    index: *index,
                    remove: *remove,
                    items: items.clone(),
                },
                Op::Replace { .. } => unreachable!(),
            });
            previous = Some(path.clone());
        }
        output
    }
}

#[derive(Default)]
pub struct DeltaDecoder {
    paths: HashMap<u64, Path>,
}
impl DeltaDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn decode(&mut self, wire: &[WireOp]) -> Result<Vec<Op>, DeltaError> {
        let mut output = Vec::new();
        let mut previous: Option<Path> = None;
        for op in wire {
            match op {
                WireOp::Replace { value } => {
                    output.push(Op::Replace { value: value.clone() });
                    self.paths.clear();
                    previous = None
                }
                WireOp::Define { id, path } => {
                    validate_path(path)?;
                    if self.paths.insert(*id, path.clone()).is_some() {
                        return Err(DeltaError::Codec(format!("duplicate path id {id}")));
                    }
                }
                WireOp::Set { path, value } => {
                    let path = self.resolve(path, &previous)?;
                    output.push(Op::Set {
                        path: path.clone(),
                        value: value.clone(),
                    });
                    previous = Some(path)
                }
                WireOp::Delete { path } => {
                    let path = self.resolve(path, &previous)?;
                    output.push(Op::Delete { path: path.clone() });
                    previous = Some(path)
                }
                WireOp::Append { path, text } => {
                    let path = self.resolve(path, &previous)?;
                    output.push(Op::Append {
                        path: path.clone(),
                        text: text.clone(),
                    });
                    previous = Some(path)
                }
                WireOp::TruncateFront { path, count } => {
                    let path = self.resolve(path, &previous)?;
                    output.push(Op::TruncateFront {
                        path: path.clone(),
                        count: *count,
                    });
                    previous = Some(path)
                }
                WireOp::Splice {
                    path,
                    index,
                    remove,
                    items,
                } => {
                    let path = self.resolve(path, &previous)?;
                    output.push(Op::Splice {
                        path: path.clone(),
                        index: *index,
                        remove: *remove,
                        items: items.clone(),
                    });
                    previous = Some(path)
                }
            }
        }
        Ok(output)
    }
    fn resolve(&self, reference: &Option<PathRef>, previous: &Option<Path>) -> Result<Path, DeltaError> {
        let path = match reference {
            None => previous
                .clone()
                .ok_or_else(|| DeltaError::Codec("omitted path without previous path".into()))?,
            Some(PathRef::Inline(path)) => path.clone(),
            Some(PathRef::Id(id)) => self
                .paths
                .get(id)
                .cloned()
                .ok_or_else(|| DeltaError::Codec(format!("unknown path id {id}")))?,
        };
        validate_path(&path)?;
        Ok(path)
    }
}

#[derive(Debug, Error)]
pub enum DeltaError {
    #[error("unsafe path segment: {0}")]
    UnsafePath(String),
    #[error("unresolvable path: {0:?}")]
    Path(Path),
    #[error("operation type does not match its target")]
    Type,
    #[error("delta codec error: {0}")]
    Codec(String),
}

fn validate_path(path: &[Segment]) -> Result<(), DeltaError> {
    for segment in path {
        if let Segment::Key(key) = segment
            && matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
        {
            return Err(DeltaError::UnsafePath(key.clone()));
        }
    }
    Ok(())
}

pub fn apply(mut root: Value, operations: &[Op]) -> Result<Value, DeltaError> {
    for operation in operations {
        match operation {
            Op::Replace { value } => root = value.clone(),
            Op::Splice {
                path,
                index,
                remove,
                items,
            } => {
                let target = resolve_mut(&mut root, path)?;
                let array = target.as_array_mut().ok_or(DeltaError::Type)?;
                if *index > array.len() {
                    return Err(DeltaError::Path(path.clone()));
                }
                let end = index.saturating_add(*remove).min(array.len());
                array.splice(*index..end, items.clone());
            }
            Op::Set { path, value } => set_path(&mut root, path, Some(value.clone()))?,
            Op::Delete { path } => set_path(&mut root, path, None)?,
            Op::Append { path, text } => {
                let target = resolve_mut(&mut root, path)?;
                let string = target.as_str().ok_or(DeltaError::Type)?.to_owned() + text;
                *target = Value::String(string);
            }
            Op::TruncateFront { path, count } => {
                let target = resolve_mut(&mut root, path)?;
                let string = target.as_str().ok_or(DeltaError::Type)?;
                *target = Value::String(string.chars().skip(*count).collect());
            }
        }
    }
    Ok(root)
}

pub fn apply_immutable(root: &Value, operations: &[Op]) -> Result<Value, DeltaError> {
    apply(root.clone(), operations)
}

fn resolve_mut<'a>(root: &'a mut Value, path: &[Segment]) -> Result<&'a mut Value, DeltaError> {
    validate_path(path)?;
    let mut current = root;
    for segment in path {
        current = match segment {
            Segment::Key(key) => current.as_object_mut().and_then(|object| object.get_mut(key)),
            Segment::Index(index) => current.as_array_mut().and_then(|array| array.get_mut(*index)),
        }
        .ok_or_else(|| DeltaError::Path(path.to_vec()))?;
    }
    Ok(current)
}

fn set_path(root: &mut Value, path: &[Segment], value: Option<Value>) -> Result<(), DeltaError> {
    validate_path(path)?;
    let (last, parent_path) = path.split_last().ok_or_else(|| DeltaError::Path(path.to_vec()))?;
    let parent = resolve_mut(root, parent_path)?;
    match (last, parent) {
        (Segment::Key(key), Value::Object(object)) => {
            if let Some(value) = value {
                object.insert(key.clone(), value);
            } else {
                object.remove(key);
            }
        }
        (Segment::Index(index), Value::Array(array)) => {
            if *index > array.len() {
                return Err(DeltaError::Path(path.to_vec()));
            }
            if let Some(value) = value {
                if *index == array.len() {
                    array.push(value);
                } else {
                    array[*index] = value;
                }
            } else if *index < array.len() {
                array.remove(*index);
            }
        }
        _ => return Err(DeltaError::Type),
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct Tracker {
    current: Value,
    baseline: Option<Value>,
    force_base: bool,
    max_overlap_scan: usize,
}

impl Tracker {
    #[must_use]
    pub fn new(value: Value) -> Self {
        Self {
            current: value,
            baseline: None,
            force_base: true,
            max_overlap_scan: 65_536,
        }
    }

    #[must_use]
    pub fn state(&self) -> &Value {
        &self.current
    }

    pub fn state_mut(&mut self) -> &mut Value {
        &mut self.current
    }

    pub fn replace_state(&mut self, value: Value) {
        self.current = value;
        self.baseline = None;
        self.force_base = true;
    }

    pub fn rebase(&mut self) {
        self.force_base = true;
    }

    pub fn discard(&mut self) {
        self.baseline = Some(self.current.clone());
        self.force_base = false;
    }

    #[must_use]
    pub fn dirty(&self) -> bool {
        self.force_base || self.baseline.as_ref() != Some(&self.current)
    }

    pub fn flush(&mut self) -> Vec<Op> {
        if self.force_base || self.baseline.is_none() {
            self.force_base = false;
            self.baseline = Some(self.current.clone());
            return vec![Op::Replace {
                value: self.current.clone(),
            }];
        }
        let mut operations = Vec::new();
        diff_value(
            self.baseline.as_ref().expect("baseline is present"),
            &self.current,
            &mut Vec::new(),
            self.max_overlap_scan,
            &mut operations,
        );
        self.baseline = Some(self.current.clone());
        operations
    }
}

fn diff_value(before: &Value, after: &Value, path: &mut Path, scan: usize, out: &mut Vec<Op>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::String(before), Value::String(after)) if !path.is_empty() => {
            if let Some(suffix) = after.strip_prefix(before) {
                out.push(Op::Append {
                    path: path.clone(),
                    text: suffix.to_owned(),
                });
            } else {
                let overlap = overlap(before, after, scan, 64, 8);
                if overlap > 0 {
                    out.push(Op::TruncateFront {
                        path: path.clone(),
                        count: before.chars().count() - overlap,
                    });
                    let suffix: String = after.chars().skip(overlap).collect();
                    if !suffix.is_empty() {
                        out.push(Op::Append {
                            path: path.clone(),
                            text: suffix,
                        });
                    }
                } else {
                    out.push(Op::Set {
                        path: path.clone(),
                        value: Value::String(after.clone()),
                    });
                }
            }
        }
        (Value::Object(before), Value::Object(after)) => diff_object(before, after, path, scan, out),
        (Value::Array(before), Value::Array(after)) => diff_array(before, after, path, scan, out),
        _ if path.is_empty() => out.push(Op::Replace { value: after.clone() }),
        _ => out.push(Op::Set {
            path: path.clone(),
            value: after.clone(),
        }),
    }
}

fn diff_object(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    path: &mut Path,
    scan: usize,
    out: &mut Vec<Op>,
) {
    for (key, value) in after {
        path.push(Segment::Key(key.clone()));
        if let Some(previous) = before.get(key) {
            diff_value(previous, value, path, scan, out);
        } else {
            out.push(Op::Set {
                path: path.clone(),
                value: value.clone(),
            });
        }
        path.pop();
    }
    for key in before.keys().filter(|key| !after.contains_key(*key)) {
        path.push(Segment::Key(key.clone()));
        out.push(Op::Delete { path: path.clone() });
        path.pop();
    }
}

fn diff_array(before: &[Value], after: &[Value], path: &mut Path, scan: usize, out: &mut Vec<Op>) {
    let common = before.len().min(after.len());
    for index in 0..common {
        path.push(Segment::Index(index));
        diff_value(&before[index], &after[index], path, scan, out);
        path.pop();
    }
    if after.len() > before.len() {
        out.push(Op::Splice {
            path: path.clone(),
            index: before.len(),
            remove: 0,
            items: after[before.len()..].to_vec(),
        });
    } else if before.len() > after.len() {
        out.push(Op::Splice {
            path: path.clone(),
            index: after.len(),
            remove: before.len() - after.len(),
            items: Vec::new(),
        });
    }
}

#[must_use]
pub fn overlap(a: &str, b: &str, scan: usize, _probe: usize, max_candidates: usize) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let start = a_chars.len().saturating_sub(scan);
    let mut candidates = 0;
    for index in start..a_chars.len() {
        if a_chars[index] == b_chars.first().copied().unwrap_or_default() {
            candidates += 1;
            if candidates > max_candidates {
                return 0;
            }
            let length = a_chars.len() - index;
            if length <= b_chars.len() && a_chars[index..] == b_chars[..length] {
                return length;
            }
        }
    }
    0
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ServiceMode {
    Singleton,
    Keyed,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Service {
    pub id: String,
    pub local: bool,
    pub mode: ServiceMode,
}

#[must_use]
pub fn define_service(id: impl Into<String>, local: bool, mode: ServiceMode) -> Service {
    Service {
        id: id.into(),
        local,
        mode,
    }
}

pub trait Facet: Send + Sync {
    fn id(&self) -> &str;
    fn activate(&self, host: &FacetHost) -> Result<(), FacetError>;
    fn deactivate(&self) -> Result<(), FacetError> {
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum FacetError {
    #[error("service {0} is unavailable")]
    Unavailable(String),
    #[error("facet {0} failed: {1}")]
    Failed(String, String),
}

#[derive(Default)]
pub struct FacetHost {
    services: RwLock<HashMap<String, Arc<dyn Any + Send + Sync>>>,
    facets: Mutex<Vec<Arc<dyn Facet>>>,
}

impl FacetHost {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn provide<T: Any + Send + Sync>(&self, service: &Service, implementation: T) {
        self.services
            .write()
            .insert(service.id.clone(), Arc::new(implementation));
    }

    pub fn use_service<T: Any + Send + Sync>(&self, service: &Service) -> Result<Arc<T>, FacetError> {
        self.services
            .read()
            .get(&service.id)
            .cloned()
            .and_then(|service| service.downcast().ok())
            .ok_or_else(|| FacetError::Unavailable(service.id.clone()))
    }

    pub fn reload(&self, facets: Vec<Arc<dyn Facet>>) -> Result<(), FacetError> {
        for facet in &facets {
            facet.activate(self)?;
        }
        let mut current = self.facets.lock();
        for old in current.iter().rev() {
            old.deactivate()?;
        }
        *current = facets;
        Ok(())
    }

    pub fn dispose(&self) -> Result<(), FacetError> {
        let mut facets = self.facets.lock();
        for facet in facets.iter().rev() {
            facet.deactivate()?;
        }
        facets.clear();
        self.services.write().clear();
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteServiceErrorCode {
    Unavailable,
    NotFound,
    InvalidCall,
    Internal,
    Cancelled,
}

#[derive(Clone, Debug, Error, Serialize, Deserialize)]
#[error("remote service error {code:?}: {message}")]
pub struct RemoteServiceError {
    pub code: RemoteServiceErrorCode,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCall {
    pub service_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<ServiceInstanceAddress>,
    pub member: String,
    pub args: Vec<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ServiceInstanceAddress {
    pub key: String,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCatalogueEntry {
    pub service_id: String,
    pub mode: ServiceMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServiceProviderUpdate {
    State {
        instance: Option<ServiceInstanceAddress>,
        member: String,
        sequence: u64,
        ops: Vec<Op>,
    },
    Unavailable,
    Replaced {
        snapshot: Value,
    },
    Spawned {
        instance: ServiceInstanceAddress,
        snapshot: Value,
    },
    Closed {
        instance: ServiceInstanceAddress,
    },
}

#[async_trait::async_trait]
pub trait RemoteServiceTransport: Send + Sync {
    async fn invoke(&self, call: ServiceCall, context: &Context) -> Result<Option<Value>, RemoteServiceError>;
    async fn subscribe(
        &self,
        service_id: &str,
        mode: ServiceMode,
        context: &Context,
    ) -> Result<(Value, tokio::sync::broadcast::Receiver<ServiceProviderUpdate>), RemoteServiceError>;
}

pub struct MutableReplicatedState {
    tracker: Mutex<Tracker>,
    value: RwLock<Value>,
    sequence: Mutex<u64>,
    updates: tokio::sync::broadcast::Sender<(Value, u64)>,
}

impl MutableReplicatedState {
    #[must_use]
    pub fn new(initial: Value) -> Self {
        let (updates, _) = tokio::sync::broadcast::channel(256);
        Self {
            tracker: Mutex::new(Tracker::new(initial.clone())),
            value: RwLock::new(initial),
            sequence: Mutex::new(0),
            updates,
        }
    }

    #[must_use]
    pub fn value(&self) -> Value {
        self.value.read().clone()
    }

    pub fn mutate<R>(&self, mutation: impl FnOnce(&mut Value) -> R) -> R {
        let mut tracker = self.tracker.lock();
        let result = mutation(tracker.state_mut());
        *self.value.write() = tracker.state().clone();
        result
    }

    pub fn publish(&self, _context: &Context) -> Vec<Op> {
        let operations = self.tracker.lock().flush();
        if !operations.is_empty() {
            let mut sequence = self.sequence.lock();
            *sequence += 1;
            let _ = self.updates.send((self.value(), *sequence));
        }
        operations
    }

    #[must_use]
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<(Value, u64)> {
        self.updates.subscribe()
    }
}

#[must_use]
pub fn replicated_state(initial: Value) -> MutableReplicatedState {
    MutableReplicatedState::new(initial)
}

#[must_use]
pub fn create_service_catalogue_call() -> ServiceCall {
    ServiceCall {
        service_id: "$chord.service".into(),
        instance: None,
        member: "catalogue".into(),
        args: Vec::new(),
    }
}

#[must_use]
pub fn create_service_subscribe_call(service_id: &str, mode: ServiceMode, subscription_id: &str) -> ServiceCall {
    ServiceCall {
        service_id: "$chord.service".into(),
        instance: None,
        member: "subscribe".into(),
        args: vec![
            serde_json::json!(service_id),
            serde_json::to_value(mode).expect("service mode"),
            serde_json::json!(subscription_id),
        ],
    }
}

#[must_use]
pub fn create_service_unsubscribe_call(subscription_id: &str) -> ServiceCall {
    ServiceCall {
        service_id: "$chord.service".into(),
        instance: None,
        member: "unsubscribe".into(),
        args: vec![serde_json::json!(subscription_id)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delta_round_trip() {
        let mut tracker = Tracker::new(json!({"output":"", "items":[]}));
        let base = tracker.flush();
        let mut replica = apply(Value::Null, &base).unwrap();
        tracker.state_mut()["output"] = json!("done\n");
        tracker.state_mut()["items"] = json!(["result"]);
        replica = apply(replica, &tracker.flush()).unwrap();
        assert_eq!(replica, tracker.state().clone());
    }

    #[test]
    fn wire_codec_round_trip_and_interns_paths() {
        let operations = vec![
            Op::Append {
                path: vec![Segment::Key("output".into())],
                text: "a".into(),
            },
            Op::Append {
                path: vec![Segment::Key("output".into())],
                text: "b".into(),
            },
        ];
        let wire = DeltaEncoder::new().encode(&operations);
        assert!(matches!(wire[1], WireOp::Append { path: None, .. }));
        assert_eq!(DeltaDecoder::new().decode(&wire).unwrap(), operations);
    }

    #[tokio::test]
    async fn context_cancellation_only_cancels_waiter() {
        let (context, token) = Context::background().with_cancel();
        token.cancel();
        assert!(context.wait(async { 1 }).await.is_err());
    }
}
