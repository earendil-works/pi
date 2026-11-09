// Async Node-API entry points for content and path searches.
mod decode;
mod grep;
mod pcre;
mod walk;

use napi::{Env, Result, Task, bindgen_prelude::AsyncTask};
use napi_derive::napi;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

#[napi]
pub struct SearchJob {
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl SearchJob {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    #[napi]
    pub fn grep(&self, options: grep::GrepOptions) -> AsyncTask<GrepTask> {
        AsyncTask::new(GrepTask {
            options,
            control: Control::new(self.cancelled.clone()),
        })
    }

    #[napi]
    pub fn glob(&self, options: walk::GlobOptions) -> AsyncTask<GlobTask> {
        AsyncTask::new(GlobTask {
            options,
            control: Control::new(self.cancelled.clone()),
        })
    }
}

pub struct Control {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl Control {
    fn new(cancelled: Arc<AtomicBool>) -> Self {
        Self {
            cancelled,
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }

    pub fn check(&self) -> std::io::Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("Operation aborted"));
        }
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::other(
                "Search timed out after 30s; narrow the search scope",
            ));
        }
        Ok(())
    }
}

pub struct GrepTask {
    options: grep::GrepOptions,
    control: Control,
}

impl Task for GrepTask {
    type Output = grep::GrepResult;
    type JsValue = grep::GrepResult;

    fn compute(&mut self) -> Result<Self::Output> {
        grep::grep(&self.options, &self.control)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct GlobTask {
    options: walk::GlobOptions,
    control: Control,
}

impl Task for GlobTask {
    type Output = walk::GlobResult;
    type JsValue = walk::GlobResult;

    fn compute(&mut self) -> Result<Self::Output> {
        walk::glob(&self.options, &self.control)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
