//! Errors as Node reports them: a code such as `ENOENT` plus a diagnostic message.

use serde_json::{Value, json};
use std::io;

/// A failure with a Node-style code; messages are diagnostic only.
#[derive(Debug)]
pub struct Failure {
    pub code: String,
    pub message: String,
    details: Option<Box<Details>>,
}

#[derive(Debug, Default)]
struct Details {
    syscall: Option<String>,
    path: Option<String>,
    /// Extra fields for the client, such as `spillPath`.
    extra: Option<Value>,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Failure {
        Failure {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    fn details(&mut self) -> &mut Details {
        self.details.get_or_insert_with(Default::default)
    }

    /// Add fields to the error JSON, such as `spillPath`.
    pub fn extra(mut self, extra: Value) -> Failure {
        self.details().extra = Some(extra);
        self
    }

    /// An I/O error of `syscall` on `path`, with libuv's error name as code.
    pub fn io(error: &io::Error, syscall: &str, path: &str) -> Failure {
        Failure::io_between(error, syscall, path, None)
    }

    /// Node's message for an error of a two-path call: `CODE: description, syscall 'from' -> 'to'`.
    pub fn io_between(
        error: &io::Error,
        syscall: &str,
        path: &str,
        destination: Option<&str>,
    ) -> Failure {
        let code = crate::sys::error_name(error).to_string();
        let description = describe(&code).map(str::to_string).unwrap_or_else(|| {
            // Unknown to libuv's table: the OS text without Rust's " (os error N)".
            let text = error.to_string();
            text.split(" (os error")
                .next()
                .unwrap_or(&text)
                .to_lowercase()
        });
        let target = match destination {
            Some(destination) => format!("'{path}' -> '{destination}'"),
            None => format!("'{path}'"),
        };
        let mut failure = Failure::new(&code, format!("{code}: {description}, {syscall} {target}"));
        failure.details().syscall = Some(syscall.to_string());
        failure.path(path)
    }

    pub fn path(mut self, path: &str) -> Failure {
        self.details().path = Some(path.to_string());
        self
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({ "code": self.code, "message": self.message });
        let Some(details) = &self.details else {
            return value;
        };
        if let Some(syscall) = &details.syscall {
            value["syscall"] = json!(syscall);
        }
        if let Some(path) = &details.path {
            value["path"] = json!(path);
        }
        if let Some(Value::Object(extra)) = &details.extra {
            for (key, field) in extra {
                value[key] = field.clone();
            }
        }
        value
    }
}

/// libuv's `uv_strerror` texts, which Node uses on every system.
fn describe(code: &str) -> Option<&'static str> {
    Some(match code {
        "EACCES" => "permission denied",
        "EAGAIN" => "resource temporarily unavailable",
        "EBADF" => "bad file descriptor",
        "EBUSY" => "resource busy or locked",
        "EEXIST" => "file already exists",
        "EFBIG" => "file too large",
        "EINVAL" => "invalid argument",
        "EIO" => "i/o error",
        "EISDIR" => "illegal operation on a directory",
        "ELOOP" => "too many symbolic links encountered",
        "EMFILE" => "too many open files",
        "EMLINK" => "too many links",
        "ENAMETOOLONG" => "name too long",
        "ENFILE" => "file table overflow",
        "ENOENT" => "no such file or directory",
        "ENOMEM" => "not enough memory",
        "ENOSPC" => "no space left on device",
        "ENOSYS" => "function not implemented",
        "ENOTDIR" => "not a directory",
        "ENOTEMPTY" => "directory not empty",
        "ENOTSUP" => "operation not supported on socket",
        "EPERM" => "operation not permitted",
        "EROFS" => "read-only file system",
        "ETXTBSY" => "text file is busy",
        "EXDEV" => "cross-device link not permitted",
        _ => return None,
    })
}
