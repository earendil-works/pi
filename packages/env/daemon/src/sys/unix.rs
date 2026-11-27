//! Linux, macOS and Android.

use super::{OpenMode, ShellConfig, path_exists};
use crate::errors::Failure;
use serde_json::{Map, Value};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// libuv's name for an OS error.
pub fn os_error_name(error: &io::Error) -> &'static str {
    let Some(errno) = error.raw_os_error() else {
        return "UNKNOWN";
    };
    match errno {
        libc::EPERM => "EPERM",
        libc::ENOENT => "ENOENT",
        libc::EIO => "EIO",
        libc::EBADF => "EBADF",
        libc::EAGAIN => "EAGAIN",
        libc::ENOMEM => "ENOMEM",
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EXDEV => "EXDEV",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::ENFILE => "ENFILE",
        libc::EMFILE => "EMFILE",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        libc::EMLINK => "EMLINK",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ELOOP => "ELOOP",
        libc::ENOSYS => "ENOSYS",
        libc::ENOTSUP => "ENOTSUP",
        _ => "UNKNOWN",
    }
}

pub const PATH_SEPARATOR: &str = "/";

pub fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

/// Modification time as seconds and nanoseconds since the epoch.
pub fn mtime(metadata: &Metadata) -> (i64, i64) {
    (metadata.mtime(), metadata.mtime_nsec())
}

/// Device and inode, which identify a file across renames.
pub fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Node's `os.tmpdir()`; Termux's Node falls back to `$PREFIX/tmp`.
pub fn tmpdir() -> String {
    let configured = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()));
    let mut path = configured.unwrap_or_else(|| {
        if cfg!(target_os = "android") {
            format!(
                "{}/tmp",
                std::env::var("PREFIX")
                    .unwrap_or_else(|_| "/data/data/com.termux/files/usr".into())
            )
        } else {
            "/tmp".into()
        }
    });
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    path
}

pub fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// `mkdtemp(3)` of `prefix`, as libuv calls it: six random characters from `[A-Za-z0-9]`.
pub fn mkdtemp(prefix: &str) -> io::Result<String> {
    let mut template = prefix.as_bytes().to_vec();
    template.extend_from_slice(b"XXXXXX");
    let template =
        CString::new(template).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut buffer = template.into_bytes_with_nul();
    // SAFETY: `buffer` is a NUL-terminated, writable template that mkdtemp fills in place.
    let created = unsafe { libc::mkdtemp(buffer.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err(io::Error::last_os_error());
    }
    buffer.pop();
    Ok(OsStr::from_bytes(&buffer).to_string_lossy().into_owned())
}

/// Open a regular file for positional reads, without blocking on FIFOs and, with `no_follow`, without following a
/// final symbolic link.
pub fn open_reader(path: &str, no_follow: bool) -> Result<File, Failure> {
    let mut flags = libc::O_NONBLOCK;
    if no_follow {
        flags |= libc::O_NOFOLLOW;
    }
    OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| {
            if no_follow && matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::EMLINK)) {
                Failure::new("SYMLINK", "Refusing to follow a symbolic link").path(path)
            } else {
                Failure::io(&error, "open", path)
            }
        })
}

/// Open a file in one of Node's write modes.
pub fn open(path: &str, mode: OpenMode) -> io::Result<File> {
    let mut options = OpenOptions::new();
    match mode {
        OpenMode::Read => options.read(true),
        OpenMode::Write => options.write(true).create(true).truncate(true),
        OpenMode::Append => options.append(true).create(true),
        OpenMode::ReadWrite => options.read(true).write(true),
    };
    options.open(path)
}

pub fn realpath(path: &str) -> io::Result<String> {
    std::fs::canonicalize(path).map(|resolved| resolved.to_string_lossy().into_owned())
}

pub fn rename(from: &str, to: &str) -> io::Result<()> {
    std::fs::rename(from, to)
}

pub fn remove_file(path: &str) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// A pipe a reader thread can poll, so that it stops when the command settles.
pub trait Pipe: io::Read + std::os::fd::AsRawFd {}
impl<T: io::Read + std::os::fd::AsRawFd> Pipe for T {}

/// Read `pipe` until it ends, `on_data` returns false, or `stop` is set (looked at every 100 ms, also while no output
/// arrives); the pipe closes when this returns.
pub fn read_pipe(mut pipe: impl Pipe, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
    let fd = pipe.as_raw_fd();
    // SAFETY: fcntl on a descriptor this thread owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut buffer = vec![0u8; 64 * 1024];
    while !stop.load(Ordering::SeqCst) {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready == 0
            || (ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted)
        {
            continue;
        }
        if ready < 0 {
            return;
        }
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => {
                if !on_data(&buffer[..read]) {
                    return;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return,
        }
    }
}

/// A pipe a writer thread can poll, so that it stops when the program settles.
pub trait WritePipe: io::Write + std::os::fd::AsRawFd {}
impl<T: io::Write + std::os::fd::AsRawFd> WritePipe for T {}

/// Write all of `bytes`, waiting while the program does not read; false once the pipe is closed or `stop` is set
/// (looked at every 100 ms, also while the write waits).
pub fn write_pipe(pipe: &mut impl WritePipe, mut bytes: &[u8], stop: &AtomicBool) -> bool {
    let fd = pipe.as_raw_fd();
    // SAFETY: fcntl on a descriptor this thread owns; only the daemon's end of the pipe becomes nonblocking.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    while !bytes.is_empty() {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        match pipe.write(bytes) {
            Ok(0) => return false,
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut poll = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one valid pollfd.
                let ready = unsafe { libc::poll(&mut poll, 1, 100) };
                if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return false;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    true
}

/// The program an argv command runs; `Command` searches `PATH` like `execvp`, as libuv does.
pub fn resolve_program(
    program: &str,
    _cwd: &str,
    _env: &Map<String, Value>,
) -> Result<String, Failure> {
    Ok(program.to_string())
}

fn which_bash() -> Option<String> {
    let output = Command::new("which")
        .arg("bash")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .trim()
        .lines()
        .next()?
        .to_string();
    path_exists(&first).then_some(first)
}

/// Node's shell resolution: a configured shell must exist; otherwise `/bin/bash`, `which bash`, then `sh`.
pub fn shell_config(shell_path: Option<&str>) -> Result<ShellConfig, Failure> {
    let shell = |program: &str| ShellConfig {
        program: program.into(),
        args: vec!["-c".into()],
        command_on_stdin: false,
    };
    if let Some(configured) = shell_path {
        if path_exists(configured) {
            return Ok(shell(configured));
        }
        return Err(Failure::new(
            "shell_unavailable",
            format!("Custom shell path not found: {configured}"),
        ));
    }
    if path_exists("/bin/bash") {
        return Ok(shell("/bin/bash"));
    }
    Ok(shell(&which_bash().unwrap_or_else(|| "sh".into())))
}

/// Arguments, environment and process setup as libuv applies them.
pub fn configure(
    command: &mut Command,
    args: &[String],
    env: &Map<String, Value>,
    inherit_env: bool,
) {
    command.args(args);
    if !inherit_env {
        command.env_clear();
    }
    for (key, value) in env {
        if let Some(value) = value.as_str() {
            command.env(key, value);
        }
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            // A new session, so a kill reaches every descendant; default signal handling and an empty mask, as libuv sets.
            libc::setsid();
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

pub fn after_spawn(_child: &Child) {}

/// Run `on_signal` with the signal on its own thread when `SIGTERM`, `SIGINT` or `SIGHUP` arrives, instead of dying
/// at once. Call before starting any other thread: threads inherit the blocked signals, so only this one receives
/// them. Commands reset their signal mask before they run.
pub fn on_exit_signal(on_signal: impl FnOnce(i32) + Send + 'static) {
    // SAFETY: a zeroed sigset_t initialized by sigemptyset, and plain signal mask calls.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };
    std::thread::spawn(move || {
        let mut signal = 0;
        // SAFETY: waits for one of the signals blocked above.
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
            on_signal(signal);
        }
    });
}

/// Kill the command's session: its process group (or the process if the group is gone), then every other group in the
/// session. Commands start in a session of their own (`setsid`), and a shell with job control puts each background job
/// in a group of its own, so a terminal's `sleep 9 &` is reached too; only what left the session (`setsid`) is not.
pub fn kill_tree(pid: u32) {
    let pid = pid as i32;
    // SAFETY: plain signal delivery.
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
    // A member may fork while the others are killed: again until none is found, or only the same ones (killed, not
    // reaped yet).
    let mut last = Vec::new();
    for _ in 0..8 {
        let members = session_members(pid);
        if members.is_empty() || members == last {
            return;
        }
        for member in &members {
            // SAFETY: plain signal delivery.
            unsafe {
                libc::kill(*member, libc::SIGKILL);
            }
        }
        last = members;
    }
}

/// The processes of session `sid`, by their session id.
fn session_members(sid: i32) -> Vec<i32> {
    // SAFETY: `getsid` only reads; a process gone meanwhile answers -1.
    let mut members: Vec<i32> = all_pids()
        .into_iter()
        .filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == sid)
        .collect();
    members.sort_unstable();
    members
}

/// Every process id this user may see: `/proc` on Linux and Android.
#[cfg(not(target_vendor = "apple"))]
fn all_pids() -> Vec<i32> {
    std::fs::read_dir("/proc")
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Every process id this user may see: the kernel's list on macOS.
#[cfg(target_vendor = "apple")]
fn all_pids() -> Vec<i32> {
    // SAFETY: a null buffer asks for the count; then a buffer of that many (and room for a few new ones) is filled.
    unsafe {
        let count = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if count <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0i32; count as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
        let filled = libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes);
        pids.truncate(filled.max(0) as usize);
        pids
    }
}

/// The process group of a `process` program: what the program started there is killed once it exits.
pub struct Group {
    pid: u32,
}

/// The group of a program just started; `configure` already made it a process group of its own.
pub fn group(child: &Child) -> io::Result<Group> {
    Ok(Group { pid: child.id() })
}

impl Group {
    /// Wait until the program has exited, leaving it unreaped: its pid, which is the group's id, names no other
    /// process until it is reaped.
    pub fn wait_for_exit(&self, child: &mut Child) -> io::Result<()> {
        loop {
            // SAFETY: a zeroed siginfo_t for waitid to fill; WNOWAIT leaves the program unreaped.
            let waited = unsafe {
                let mut info: libc::siginfo_t = std::mem::zeroed();
                libc::waitid(
                    libc::P_PID,
                    child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if waited == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    /// Kill what is left in the group, the program too if it still runs.
    pub fn end(&self) {
        kill_tree(self.pid);
    }
}

/// A process killed by a signal has no exit code; report 128 + the signal, as the shell does.
pub fn exit_code(status: ExitStatus) -> i64 {
    i64::from(
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
    )
}

/// The bytes of a file name, which libuv sorts directory listings by.
pub fn raw_name(name: &OsStr) -> Option<Vec<u8>> {
    Some(name.as_bytes().to_vec())
}

/// Windows only: the per-drive working directories of the `=C:` variables.
pub fn drive_cwds() -> Map<String, Value> {
    Map::new()
}

pub fn read_dir(path: &str) -> io::Result<std::fs::ReadDir> {
    std::fs::read_dir(path)
}

/// Device and inode of `path`; the metadata already has them.
pub fn path_identity(_path: &str, metadata: &Metadata, _follow: bool) -> (u64, u64) {
    identity(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    #[test]
    fn ending_a_group_kills_what_the_program_left_running() {
        // A wrapper that starts a background process in its group, prints its pid and exits, as `npx` can.
        let mut command = Command::new("/bin/sh");
        command.stdout(Stdio::piped());
        let script = "sleep 30 </dev/null >/dev/null 2>&1 & echo $!";
        configure(
            &mut command,
            &["-c".to_string(), script.to_string()],
            &Map::new(),
            true,
        );
        let mut child = command.spawn().unwrap();
        let group = group(&child).unwrap();
        let mut stdout = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        let sleeper: i32 = stdout.trim().parse().unwrap();
        group.wait_for_exit(&mut child).unwrap();
        group.end();
        assert!(child.wait().unwrap().success());
        // The killed sleeper is an orphan; it is gone once init has reaped it.
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(sleeper, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above.
        assert_ne!(unsafe { libc::kill(sleeper, 0) }, 0);
    }

    #[test]
    fn killing_a_session_kills_its_jobs_in_groups_of_their_own() {
        // A shell with job control, as a terminal's is: its background job gets a process group of its own (bash: a
        // POSIX `sh` may not do job control without a terminal).
        let mut command = Command::new("bash");
        command.stdout(Stdio::piped());
        let script = "set -m; sleep 30 </dev/null >/dev/null 2>&1 & echo $!; wait";
        configure(
            &mut command,
            &["-c".to_string(), script.to_string()],
            &Map::new(),
            true,
        );
        let mut child = command.spawn().unwrap();
        let mut line = Vec::new();
        let mut stdout = child.stdout.take().unwrap();
        let mut byte = [0u8; 1];
        while stdout.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' {
            line.push(byte[0]);
        }
        let job: i32 = String::from_utf8(line).unwrap().trim().parse().unwrap();
        // SAFETY: plain process queries.
        assert_ne!(
            unsafe { libc::getpgid(job) },
            child.id() as i32,
            "the job has a group of its own"
        );
        kill_tree(child.id());
        let _ = child.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(job, 0) } == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: as above.
        assert_ne!(
            unsafe { libc::kill(job, 0) },
            0,
            "the job ended with its session"
        );
    }
}
