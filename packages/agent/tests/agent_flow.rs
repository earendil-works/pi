#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use pi_agent_core::{Agent, AgentHooks, AgentOptions, AgentTool, AgentToolResult, BeforeToolDecision};
use pi_ai::{
    FauxProvider, InMemoryCredentialStore, Models, StopReason, faux_assistant_message, faux_text, faux_tool_call,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

struct Echo;
#[async_trait]
impl AgentTool for Echo {
    fn name(&self) -> &str {
        "echo"
    }
    fn label(&self) -> &str {
        "Echo"
    }
    fn description(&self) -> &str {
        "echo text"
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"]})
    }
    async fn execute(
        &self,
        _: &str,
        parameters: Value,
        _: CancellationToken,
    ) -> Result<AgentToolResult, pi_agent_core::AgentError> {
        Ok(AgentToolResult::text(parameters["text"].as_str().unwrap()))
    }
}

#[tokio::test]
async fn executes_tool_and_continues() {
    let provider = "flow";
    let model = FauxProvider::default_model(provider, "model");
    let faux = Arc::new(FauxProvider::new(provider, vec![model.clone()], None));
    faux.set_responses([
        faux_assistant_message(
            &model,
            vec![faux_tool_call("echo", json!({"text":"ok"}))],
            StopReason::ToolUse,
        ),
        faux_assistant_message(&model, vec![faux_text("done")], StopReason::Stop),
    ]);
    let models = Models::new(Arc::new(InMemoryCredentialStore::default()));
    models.set_provider(faux.clone());
    let mut options = AgentOptions::new(model);
    options.tools = vec![Arc::new(Echo)];
    let agent = Agent::new(models, options);
    let messages = agent.prompt("go").await.unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(faux.call_count(), 2);
}

struct BlockingHooks;
#[async_trait]
impl AgentHooks for BlockingHooks {
    async fn before_tool_call(
        &self,
        _assistant: &pi_ai::AssistantMessage,
        _call: &pi_ai::Content,
        _args: &Value,
        _context: &pi_ai::Context,
        _cancellation: CancellationToken,
    ) -> BeforeToolDecision {
        BeforeToolDecision {
            block: true,
            reason: Some("denied".into()),
            terminate: true,
        }
    }
}

#[tokio::test]
async fn hooks_can_block_and_terminate_tool_batches() {
    let provider = "hooks";
    let model = FauxProvider::default_model(provider, "model");
    let faux = Arc::new(FauxProvider::new(provider, vec![model.clone()], None));
    faux.set_responses([faux_assistant_message(
        &model,
        vec![faux_tool_call("echo", json!({"text":"never"}))],
        StopReason::ToolUse,
    )]);
    let models = Models::new(Arc::new(InMemoryCredentialStore::default()));
    models.set_provider(faux.clone());
    let mut options = AgentOptions::new(model);
    options.tools = vec![Arc::new(Echo)];
    options.hooks = Some(Arc::new(BlockingHooks));
    let agent = Agent::new(models, options);
    let messages = agent.prompt("go").await.unwrap();
    assert_eq!(faux.call_count(), 1);
    assert!(matches!(
        messages.last(),
        Some(pi_ai::Message::ToolResult { is_error: true, .. })
    ));
}
