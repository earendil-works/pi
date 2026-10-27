//! What differs between operating systems: error names, positional reads, temporary directories, opening readers,
//! and starting and killing commands. Each implementation follows what Node (libuv) does on that system.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// How a string command runs: the shell, its arguments before the command, and whether the command goes to its
/// stdin instead of its arguments (legacy WSL `bash.exe`).
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
    pub command_on_stdin: bool,
}

/// How Node opens files: `r`, `writeFile` (`w`), `appendFile` (`a`), and `r+` for truncate and fsync.
#[derive(Clone, Copy)]
pub enum OpenMode {
    /// Node's `open(path, "r")`: any kind of file, blocking reads.
    Read,
    Write,
    Append,
    ReadWrite,
}

/// An error code libuv reports where the system call itself reported another one, such as `ENOTDIR` from a recursive
/// `mkdir` through a file, or `EISDIR` when Windows creates a file where a directory exists.
#[derive(Debug)]
pub struct Synthetic(pub &'static str);

impl std::fmt::Display for Synthetic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for Synthetic {}

pub fn synthetic(code: &'static str) -> std::io::Error {
    std::io::Error::other(Synthetic(code))
}

/// The libuv name of an error: a synthetic code, or the system's code translated per platform.
pub fn error_name(error: &std::io::Error) -> &'static str {
    if let Some(Synthetic(code)) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Synthetic>())
    {
        return code;
    }
    os_error_name(error)
}

/// Whether a path exists, following symbolic links, like Node's `access(path, F_OK)`.
pub fn path_exists(path: &str) -> bool {
    std::path::Path::new(path).metadata().is_ok()
}

/// Sixteen random bytes for temporary names (not for secrets).
pub fn random_bytes() -> [u8; 16] {
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let state = std::collections::hash_map::RandomState::new();
    let mut bytes = [0u8; 16];
    for half in 0..2 {
        let mut hasher = state.build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or(0),
        );
        bytes[half * 8..half * 8 + 8].copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes
}

/// The daemon's working directory, the `process.cwd()` Node's `path.resolve` falls back to.
pub fn cwd() -> String {
    std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default()
}
