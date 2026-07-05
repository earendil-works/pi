use crate::types::AssistantMessage;
use crate::types::AssistantMessageEvent;
use futures::Stream;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use tokio::sync::mpsc;

/// An async event stream for assistant messages.
///
/// Mirrors the TS `AssistantMessageEventStream` — it is both a
/// `Stream<Item = AssistantMessageEvent>` and a future (via `result()`)
/// that resolves to the final `AssistantMessage`.
///
/// # Lifecycle
///
/// The producer side (via `EventStreamSender`) pushes events into the stream.
/// Terminal events (`Done` or `Error`) finalize both the stream and the result
/// future.
pub struct AssistantMessageEventStream {
    rx: mpsc::UnboundedReceiver<AssistantMessageEvent>,
    /// Accumulated final message, collected from the terminal event.
    result_receiver: tokio::sync::oneshot::Receiver<AssistantMessage>,
    /// Set once the terminal event has been pushed.
    done: bool,
}

/// The producing half of an event stream.
///
/// Push events into this; the consumer reads them from
/// `AssistantMessageEventStream`.
pub struct EventStreamSender {
    tx: mpsc::UnboundedSender<AssistantMessageEvent>,
    result_tx: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<AssistantMessage>>>,
}

impl EventStreamSender {
    /// Push an event onto the stream. Terminal events are passed through;
    /// the first terminal event also sends the result to `result()`.
    pub fn push(&self, event: AssistantMessageEvent) -> Result<(), AssistantMessageEvent> {
        // Extract result from terminal events — but this is best-effort
        // since the sender doesn't know if it's been called already.
        let terminal_result = match &event {
            AssistantMessageEvent::Done { message, .. } => Some(message.clone()),
            AssistantMessageEvent::Error { error, .. } => Some(error.clone()),
            _ => None,
        };

        if let Err(e) = self.tx.send(event) {
            return Err(e.0);
        }

        // Only the first terminal event sends the result; later ones are ignored.
        if let Some(msg) = terminal_result {
            if let Ok(mut guard) = self.result_tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(msg);
                }
            }
        }

        Ok(())
    }
}

/// Create a new event stream, returning the consumer and the producer.
pub fn create_event_stream() -> (AssistantMessageEventStream, EventStreamSender) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (result_tx, result_receiver) = tokio::sync::oneshot::channel();

    let stream = AssistantMessageEventStream {
        rx,
        result_receiver,
        done: false,
    };
    let sender = EventStreamSender {
        tx,
        result_tx: std::sync::Mutex::new(Some(result_tx)),
    };

    (stream, sender)
}

impl Stream for AssistantMessageEventStream {
    type Item = AssistantMessageEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }

        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(event)) => {
                if event.is_terminal() {
                    self.done = true;
                }
                Poll::Ready(Some(event))
            }
            Poll::Ready(None) => {
                // Channel closed without terminal event
                self.done = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl AssistantMessageEventStream {
    /// Consume the stream and return the final `AssistantMessage`.
    ///
    /// This future resolves once the terminal event has been pushed.
    /// If the stream is dropped before a terminal event arrives, this
    /// future is cancelled.
    pub async fn result(self) -> Result<AssistantMessage, tokio::sync::oneshot::error::RecvError> {
        // Drop the receiver so the stream's poll won't deadlock.
        // The oneshot channel carries the result independently.
        drop(self.rx);
        self.result_receiver.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    fn make_terminal_msg(stop_reason: StopReason) -> AssistantMessage {
        AssistantMessage {
            role: "assistant".into(),
            content: vec![],
            api: Api::OpenAiCompletions,
            provider: ProviderId::Known(KnownProvider::OpenAI),
            model: "gpt-4o".into(),
            response_model: None,
            response_id: None,
            usage: Usage::default(),
            stop_reason,
            error_message: None,
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }

    #[tokio::test]
    async fn test_stream_and_result() {
        let (stream, sender) = create_event_stream();

        let msg = make_terminal_msg(StopReason::Stop);
        let msg_clone = msg.clone();

        // Push some events then a terminal event
        let handle = tokio::spawn(async move {
            sender
                .push(AssistantMessageEvent::TextDelta {
                    content_index: 0,
                    delta: "Hello".into(),
                    partial: msg_clone.clone(),
                })
                .unwrap();
            sender
                .push(AssistantMessageEvent::Done {
                    reason: StopReason::Stop,
                    message: msg_clone,
                })
                .unwrap();
        });

        // Collect stream items
        let events: Vec<AssistantMessageEvent> = futures::StreamExt::collect(stream).await;
        handle.await.unwrap();

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], AssistantMessageEvent::TextDelta { .. }));
        assert!(matches!(events[1], AssistantMessageEvent::Done { .. }));
    }

    #[tokio::test]
    async fn test_result_after_stream() {
        let (stream, sender) = create_event_stream();
        let msg = make_terminal_msg(StopReason::Stop);
        let msg_clone = msg.clone();

        sender
            .push(AssistantMessageEvent::Done {
                reason: StopReason::Stop,
                message: msg_clone,
            })
            .unwrap();

        // result() should return the terminal message
        let result = stream.result().await.unwrap();
        assert_eq!(result.stop_reason, StopReason::Stop);
        assert_eq!(result.model, "gpt-4o");
    }
}
