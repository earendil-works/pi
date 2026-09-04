#![allow(missing_docs)]
//! Vendor-neutral, explicitly propagated telemetry for Pi.

use std::{collections::BTreeMap, future::Future, sync::Arc};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type AttributeValue = Value;
pub type SpanAttributes = BTreeMap<String, AttributeValue>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SpanOptions {
    pub name: String,
    #[serde(default)]
    pub attributes: SpanAttributes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SpanStatus {
    Ok,
    Error { name: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedTelemetryEvent {
    pub name: String,
    pub attributes: SpanAttributes,
    pub sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecordedTelemetrySpan {
    pub id: u64,
    pub parent_id: Option<u64>,
    pub name: String,
    pub attributes: SpanAttributes,
    pub events: Vec<RecordedTelemetryEvent>,
    pub status: SpanStatus,
    pub settled: bool,
    pub end_sequence: Option<u64>,
}

pub trait TelemetrySpan: TelemetryContext {
    fn set_attributes(&self, attributes: SpanAttributes);
    fn add_event(&self, name: &str, attributes: SpanAttributes);
    fn set_status(&self, status: SpanStatus);
    fn finish(&self);
}

pub trait TelemetryContext: Send + Sync {
    fn start_span(&self, options: SpanOptions) -> Arc<dyn TelemetrySpan>;
}

pub async fn in_span<T, F, Fut>(context: &dyn TelemetryContext, options: SpanOptions, callback: F) -> T
where
    F: FnOnce(Arc<dyn TelemetrySpan>) -> Fut,
    Fut: Future<Output = T>,
{
    let span = context.start_span(options);
    let value = callback(span.clone()).await;
    span.finish();
    value
}

pub async fn in_span_result<T, E, F, Fut>(
    context: &dyn TelemetryContext,
    options: SpanOptions,
    callback: F,
) -> Result<T, E>
where
    E: std::fmt::Display,
    F: FnOnce(Arc<dyn TelemetrySpan>) -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let span = context.start_span(options);
    let result = callback(span.clone()).await;
    if let Err(error) = &result {
        span.set_status(SpanStatus::Error {
            name: std::any::type_name::<E>().into(),
            message: error.to_string(),
        });
    }
    span.finish();
    result
}

#[derive(Default)]
struct MemoryState {
    sequence: u64,
    spans: Vec<RecordedTelemetrySpan>,
}

#[derive(Clone, Default)]
pub struct InMemoryTelemetryContext {
    state: Arc<Mutex<MemoryState>>,
    parent_id: Option<u64>,
}

impl InMemoryTelemetryContext {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn get_spans(&self) -> Vec<RecordedTelemetrySpan> {
        self.state.lock().spans.clone()
    }
}

impl TelemetryContext for InMemoryTelemetryContext {
    fn start_span(&self, options: SpanOptions) -> Arc<dyn TelemetrySpan> {
        let mut state = self.state.lock();
        state.sequence += 1;
        let id = state.sequence;
        state.spans.push(RecordedTelemetrySpan {
            id,
            parent_id: self.parent_id,
            name: options.name,
            attributes: options.attributes,
            events: Vec::new(),
            status: SpanStatus::Ok,
            settled: false,
            end_sequence: None,
        });
        Arc::new(MemorySpan {
            state: self.state.clone(),
            id,
        })
    }
}

struct MemorySpan {
    state: Arc<Mutex<MemoryState>>,
    id: u64,
}

impl MemorySpan {
    fn update(&self, update: impl FnOnce(&mut RecordedTelemetrySpan, u64)) {
        let mut state = self.state.lock();
        state.sequence += 1;
        let sequence = state.sequence;
        if let Some(span) = state.spans.iter_mut().find(|span| span.id == self.id)
            && !span.settled
        {
            update(span, sequence);
        }
    }
}

impl TelemetryContext for MemorySpan {
    fn start_span(&self, options: SpanOptions) -> Arc<dyn TelemetrySpan> {
        let context = InMemoryTelemetryContext {
            state: self.state.clone(),
            parent_id: Some(self.id),
        };
        context.start_span(options)
    }
}

impl TelemetrySpan for MemorySpan {
    fn set_attributes(&self, attributes: SpanAttributes) {
        self.update(|span, _| {
            for (key, value) in attributes {
                if !value.is_null() {
                    span.attributes.insert(key, value);
                }
            }
        });
    }

    fn add_event(&self, name: &str, attributes: SpanAttributes) {
        let name = name.to_owned();
        self.update(|span, sequence| {
            span.events.push(RecordedTelemetryEvent {
                name,
                attributes,
                sequence,
            });
        });
    }

    fn set_status(&self, status: SpanStatus) {
        self.update(|span, _| span.status = status);
    }

    fn finish(&self) {
        self.update(|span, sequence| {
            span.settled = true;
            span.end_sequence = Some(sequence);
        });
    }
}

#[derive(Clone, Default)]
pub struct NoopTelemetryContext;

struct NoopSpan;

impl TelemetryContext for NoopTelemetryContext {
    fn start_span(&self, _options: SpanOptions) -> Arc<dyn TelemetrySpan> {
        Arc::new(NoopSpan)
    }
}

impl TelemetryContext for NoopSpan {
    fn start_span(&self, _options: SpanOptions) -> Arc<dyn TelemetrySpan> {
        Arc::new(NoopSpan)
    }
}

impl TelemetrySpan for NoopSpan {
    fn set_attributes(&self, _attributes: SpanAttributes) {}
    fn add_event(&self, _name: &str, _attributes: SpanAttributes) {}
    fn set_status(&self, _status: SpanStatus) {}
    fn finish(&self) {}
}

pub static NOOP_TELEMETRY_CONTEXT: NoopTelemetryContext = NoopTelemetryContext;

pub type TelemetrySchemaDefinition = Value;

#[must_use]
pub fn define_telemetry_schema(schema: Value) -> Value {
    schema
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn records_parentage_and_settlement() {
        let telemetry = InMemoryTelemetryContext::new();
        in_span(
            &telemetry,
            SpanOptions {
                name: "parent".into(),
                ..SpanOptions::default()
            },
            |parent| async move {
                let child = parent.start_span(SpanOptions {
                    name: "child".into(),
                    ..SpanOptions::default()
                });
                child.add_event("work", BTreeMap::new());
                child.finish();
            },
        )
        .await;
        let spans = telemetry.get_spans();
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[1].parent_id, Some(spans[0].id));
        assert!(spans.iter().all(|span| span.settled));
    }
}
