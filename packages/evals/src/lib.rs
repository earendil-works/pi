#![allow(missing_docs)]
//! Model-backed evaluation harness for the Rust Pi coding agent.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use pi_agent_core::SessionManager;
use pi_ai::{Message, Model, Models, Usage};
use pi_coding_agent::{AgentSession, Resources, Settings, last_assistant_text};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvalResult {
    pub output: String,
    pub messages: Vec<Message>,
    pub usage: Usage,
    pub elapsed: Duration,
}
pub struct EvalHarness {
    models: Models,
    model: Model,
    cwd: PathBuf,
    settings: Settings,
    resources: Resources,
    no_tools: bool,
    system_prompt: Option<String>,
}
impl EvalHarness {
    #[must_use]
    pub fn new(models: Models, model: Model, cwd: impl Into<PathBuf>) -> Self {
        Self {
            models,
            model,
            cwd: cwd.into(),
            settings: Settings::default(),
            resources: Resources::default(),
            no_tools: false,
            system_prompt: None,
        }
    }
    pub fn set_no_tools(&mut self, value: bool) {
        self.no_tools = value
    }
    pub fn set_system_prompt(&mut self, prompt: impl Into<String>) {
        self.system_prompt = Some(prompt.into())
    }
    pub fn set_resources(&mut self, resources: Resources) {
        self.resources = resources
    }
    pub async fn run(&self, prompt: &str) -> Result<EvalResult, pi_agent_core::AgentError> {
        let session = Arc::new(AgentSession::new(
            self.models.clone(),
            self.model.clone(),
            self.settings.clone(),
            self.resources.clone(),
            SessionManager::in_memory(&self.cwd),
            self.cwd.clone(),
            self.no_tools.then(Vec::new),
            None,
            self.system_prompt.clone(),
            None,
        ));
        let started = Instant::now();
        session.prompt(prompt, None).await?;
        let messages = session.messages();
        let usage = messages
            .iter()
            .filter_map(|message| match message {
                Message::Assistant { message } => Some(&message.usage),
                Message::ToolResult { usage: Some(usage), .. } => Some(usage),
                _ => None,
            })
            .fold(Usage::default(), |mut total, usage| {
                total.input += usage.input;
                total.output += usage.output;
                total.cache_read += usage.cache_read;
                total.cache_write += usage.cache_write;
                total.total_tokens += usage.total_tokens;
                total.cost.input += usage.cost.input;
                total.cost.output += usage.cost.output;
                total.cost.cache_read += usage.cost.cache_read;
                total.cost.cache_write += usage.cost.cache_write;
                total.cost.total += usage.cost.total;
                total
            });
        Ok(EvalResult {
            output: last_assistant_text(&messages),
            messages,
            usage,
            elapsed: started.elapsed(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ComparativeScore {
    pub baseline_pass_rate: f64,
    pub candidate_pass_rate: f64,
    pub lift_percentage_points: f64,
}
#[must_use]
pub fn compare_scores(baseline: &[f64], candidate: &[f64]) -> ComparativeScore {
    let rate = |values: &[f64]| {
        if values.is_empty() {
            0.0
        } else {
            values.iter().filter(|score| **score >= 1.0).count() as f64 / values.len() as f64
        }
    };
    let baseline_pass_rate = rate(baseline);
    let candidate_pass_rate = rate(candidate);
    ComparativeScore {
        baseline_pass_rate,
        candidate_pass_rate,
        lift_percentage_points: (candidate_pass_rate - baseline_pass_rate) * 100.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn computes_lift() {
        let score = compare_scores(&[0.0, 1.0], &[1.0, 1.0]);
        assert!((score.lift_percentage_points - 50.0).abs() < f64::EPSILON);
    }
}
