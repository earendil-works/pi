//! `pty`: a program in a pseudo-terminal, for interactive terminals. Unlike `exec`, output is the terminal's raw
//! bytes, and the program reads input: `ptyWrite`, `ptyResize` and `ptyForeground` address the running `pty` request by
//! its id.

use crate::errors::Failure;
use crate::exec::{Control, Groups};
#[cfg(unix)]
use crate::exec::{Message, kill_group};
#[cfg(unix)]
use crate::frame::{EVENT, Frame};
use crate::output::Output;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// After the program exits, output still arriving is collected until this much silence.
#[cfg(unix)]
const EXIT_GRACE: std::time::Duration = std::time::Duration::from_millis(100);
/// Largest terminal size accepted, in cells.
const MAX_CELLS: u64 = 4096;

/// What `ptyWrite`, `ptyResize` and `ptyForeground` reach: the terminal of one running `pty` request.
pub struct Terminal {
    input: Sender<Vec<u8>>,
    #[cfg(unix)]
    master: Arc<std::fs::File>,
    /// The program's process id, which is also its process group's (it leads the terminal's session).
    #[cfg(unix)]
    pid: u32,
}

/// Running terminals by the id of their `pty` request.
pub type Terminals = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;

#[cfg_attr(not(unix), allow(dead_code))]
pub struct PtyRequest {
    argv: Option<Vec<String>>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
    cols: u16,
    rows: u16,
}

fn size(json: &Value, key: &str) -> Result<u16, Failure> {
    match json[key].as_u64() {
        Some(value) if (1..=MAX_CELLS).contains(&value) => Ok(value as u16),
        _ => Err(Failure::new(
            "EINVAL",
            format!("{key} must be between 1 and {MAX_CELLS}"),
        )),
    }
}

impl PtyRequest {
    pub fn from_json(json: &Value) -> Result<PtyRequest, Failure> {
        let argv = match &json["argv"] {
            Value::Null => None,
            value => Some(
                value
                    .as_array()
                    .and_then(|items| {
                        items
                            .iter()
                            .map(|item| item.as_str().map(str::to_string))
                            .collect()
                    })
                    .filter(|argv: &Vec<String>| !argv.is_empty())
                    .ok_or_else(|| {
                        Failure::new("EINVAL", "argv must be a non-empty array of strings")
                    })?,
            ),
        };
        Ok(PtyRequest {
            argv,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "pty needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
            cols: size(json, "cols")?,
            rows: size(json, "rows")?,
        })
    }
}

fn find(terminals: &Terminals, json: &Value) -> Result<Arc<Terminal>, Failure> {
    let target = json["target"]
        .as_u64()
        .ok_or_else(|| Failure::new("EINVAL", "missing field target"))?;
    terminals
        .lock()
        .unwrap()
        .get(&(target as u32))
        .cloned()
        .ok_or_else(|| Failure::new("EBADF", "no running terminal with this id"))
}

/// Queue input for the terminal; it is written in the order it arrives, without holding up other requests.
pub fn write(terminals: &Terminals, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    terminal
        .input
        .send(payload)
        .map_err(|_| Failure::new("EBADF", "the terminal has ended"))?;
    Ok(json!({}))
}

/// Change the terminal's size; the program receives `SIGWINCH`.
pub fn resize(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    let (cols, rows) = (size(json, "cols")?, size(json, "rows")?);
    #[cfg(unix)]
    unix::set_size(&terminal.master, cols, rows)
        .map_err(|error| Failure::io(&error, "ioctl", "pty"))?;
    #[cfg(not(unix))]
    let _ = (terminal, cols, rows);
    Ok(json!({}))
}

/// The process group in the terminal's foreground when it is not the program's own: a job a shell started, such as an
/// editor. `{ foreground: null }` while the program itself is in front (a shell at its prompt).
pub fn foreground(terminals: &Terminals, json: &Value) -> Result<Value, Failure> {
    let terminal = find(terminals, json)?;
    #[cfg(unix)]
    {
        let group = unix::foreground(&terminal.master)
            .map_err(|error| Failure::io(&error, "tcgetpgrp", "pty"))?;
        if group <= 0 || group as u32 == terminal.pid {
            return Ok(json!({ "foreground": null }));
        }
        let name = unix::process_name(group);
        Ok(json!({ "foreground": { "pid": group, "name": name } }))
    }
    #[cfg(not(unix))]
    {
        let _ = terminal;
        Ok(json!({ "foreground": null }))
    }
}

#[cfg(not(unix))]
pub fn run(
    _id: u32,
    _request: PtyRequest,
    _output: &Arc<Output>,
    _control: &Control,
    _groups: &Groups,
    _terminals: &Terminals,
) -> Result<Value, Failure> {
    Err(Failure::new(
        "ENOTSUP",
        "Terminals are not supported on this system yet",
    ))
}

/// Run the program in a new terminal, sending a `started` event and then its output, until it exits.
#[cfg(unix)]
pub fn run(
    id: u32,
    request: PtyRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    terminals: &Terminals,
) -> Result<Value, Failure> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::thread;
    use std::time::{Duration, Instant};

    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    if !std::path::Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let (master, child) =
        unix::spawn(&request).map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let master = Arc::new(master);
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let (input, inputs) = mpsc::channel::<Vec<u8>>();
    terminals.lock().unwrap().insert(
        id,
        Arc::new(Terminal {
            input,
            master: master.clone(),
            pid,
        }),
    );
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    let stop = Arc::new(AtomicBool::new(false));
    // A thread that cannot start (a task limit) fails the terminal; the started program is killed and reaped.
    let abandon = |mut child: std::process::Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        let _ = child.wait();
        terminals.lock().unwrap().remove(&id);
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    let started = {
        let master = master.clone();
        let sender = sender.clone();
        let stop = stop.clone();
        let output = output.clone();
        thread::Builder::new().spawn(move || {
            unix::read(&master, &stop, |bytes| {
                let delivered = sender.send(Message::Data(0, bytes.to_vec())).is_ok();
                // Like a full pipe: a program that writes faster than the link waits.
                output.wait_for_room(&stop);
                delivered
            });
            let _ = sender.send(Message::Eof(0));
        })
    };
    let reader = match started {
        Ok(reader) => reader,
        Err(error) => return Err(abandon(child, error)),
    };
    let started = {
        let master = master.clone();
        let stop = stop.clone();
        thread::Builder::new().spawn(move || {
            for bytes in inputs {
                if !unix::write_all(&master, &bytes, &stop) {
                    return;
                }
            }
        })
    };
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    // The waiter receives the child once it runs, so a waiter that cannot start leaves the child here to reap.
    let (give, take) = mpsc::channel::<std::process::Child>();
    let waiter = sender.clone();
    let started = thread::Builder::new().spawn(move || {
        let Ok(mut child) = take.recv() else {
            return;
        };
        let _ = waiter.send(match child.wait() {
            Ok(status) => Message::Exit(status),
            Err(error) => Message::WaitFailed(error.to_string()),
        });
    });
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    let _ = give.send(child);
    drop(sender);

    let mut status = None;
    let mut ended = false;
    let mut idle_until: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            kill_group(pid);
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        if status.is_some() && ended {
            break;
        }
        let wait = match idle_until {
            Some(idle) => {
                let now = Instant::now();
                if now >= idle {
                    // A background job may keep the terminal open after the program exited.
                    break;
                }
                idle - now
            }
            None => Duration::from_secs(3600),
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(_, bytes)) => {
                output.bulk(
                    Frame::with_payload(EVENT, id, json!({ "kind": "output" }), bytes),
                    None,
                );
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_GRACE);
                }
            }
            Ok(Message::Eof(_)) => ended = true,
            Ok(Message::Exit(exit)) => {
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_GRACE);
            }
            Ok(Message::WaitFailed(error)) => {
                status = Some(Err(error));
                idle_until = Some(Instant::now());
            }
            Ok(Message::Cancel) => {
                aborted = true;
                kill(&mut killed);
            }
            Ok(Message::Kill) => kill(&mut killed),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    stop.store(true, Ordering::SeqCst);
    // Ending the input channel ends the writer thread.
    terminals.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    let _ = reader.join();
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": crate::sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}

#[cfg(unix)]
mod unix {
    use super::PtyRequest;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::Value;

    fn check(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }

    fn winsize(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }

    pub fn set_size(master: &File, cols: u16, rows: u16) -> io::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
        check(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) })?;
        Ok(())
    }

    /// The terminal's foreground process group.
    pub fn foreground(master: &File) -> io::Result<libc::pid_t> {
        // SAFETY: tcgetpgrp on a descriptor the terminal owns.
        let group = unsafe { libc::tcgetpgrp(master.as_raw_fd()) };
        if group < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(group)
        }
    }

    /// A process's name, if it still runs and the system tells.
    #[cfg(target_vendor = "apple")]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut buffer = [0u8; 256];
        // SAFETY: proc_name writes at most `buffer.len()` bytes and returns how many.
        let length =
            unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (length > 0).then(|| String::from_utf8_lossy(&buffer[..length as usize]).into_owned())
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    pub fn process_name(pid: libc::pid_t) -> Option<String> {
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        Some(name.trim_end().to_string()).filter(|name| !name.is_empty())
    }

    #[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
    pub fn process_name(_pid: libc::pid_t) -> Option<String> {
        None
    }

    fn cloexec(fd: libc::c_int) -> io::Result<()> {
        // SAFETY: fcntl on a descriptor this function's caller owns.
        unsafe {
            let flags = check(libc::fcntl(fd, libc::F_GETFD))?;
            check(libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC))?;
        }
        Ok(())
    }

    /// The program to run: `argv`, or the user's shell as a login shell (`-` before its name, as `login` does).
    fn command(request: &PtyRequest) -> Command {
        match &request.argv {
            Some(argv) => {
                let mut command = Command::new(&argv[0]);
                command.args(&argv[1..]);
                command
            }
            None => {
                let shell = request
                    .env
                    .get("SHELL")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| std::env::var("SHELL").ok())
                    .filter(|shell| !shell.is_empty() && crate::sys::path_exists(shell))
                    .unwrap_or_else(|| "/bin/sh".into());
                let name = shell.rsplit('/').next().unwrap_or("sh").to_string();
                let mut command = Command::new(&shell);
                command.arg0(format!("-{name}"));
                command
            }
        }
    }

    pub fn spawn(request: &PtyRequest) -> io::Result<(File, Child)> {
        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut size = winsize(request.cols, request.rows);
        // SAFETY: openpty writes two descriptors; the name and termios are not requested.
        check(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut size,
            )
        })?;
        // SAFETY: openpty returned two new descriptors this function now owns.
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        cloexec(master.as_raw_fd())?;
        cloexec(slave.as_raw_fd())?;
        let slave = File::from(slave);
        let mut command = command(request);
        command
            .current_dir(&request.cwd)
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        if !request.inherit_env {
            command.env_clear();
        }
        for (key, value) in &request.env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                // A new session whose controlling terminal is the pty (stdin), so job control and SIGHUP work; default
                // signal handling and an empty mask, as for `exec`.
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
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
        let child = command.spawn()?;
        // Only the program holds the terminal now, so reads end once it and its descendants close it.
        drop(slave);
        let master = File::from(master);
        // SAFETY: fcntl on the descriptor owned above; reads and writes poll instead of blocking.
        unsafe {
            let flags = check(libc::fcntl(master.as_raw_fd(), libc::F_GETFL))?;
            check(libc::fcntl(
                master.as_raw_fd(),
                libc::F_SETFL,
                flags | libc::O_NONBLOCK,
            ))?;
        }
        Ok((master, child))
    }

    fn poll(fd: libc::c_int, events: libc::c_short) -> io::Result<bool> {
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            };
        }
        Ok(ready > 0)
    }

    /// Read until the terminal closes (Linux reports `EIO` once no program holds it), `on_data` returns false, or
    /// `stop` is set.
    pub fn read(master: &File, stop: &AtomicBool, mut on_data: impl FnMut(&[u8]) -> bool) {
        let mut buffer = vec![0u8; 64 * 1024];
        while !stop.load(Ordering::SeqCst) {
            match poll(master.as_raw_fd(), libc::POLLIN) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(_) => return,
            }
            match (&*master).read(&mut buffer) {
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

    /// Write all of `bytes`, waiting while the program does not read its input; false once the terminal is gone.
    pub fn write_all(master: &File, mut bytes: &[u8], stop: &AtomicBool) -> bool {
        while !bytes.is_empty() {
            if stop.load(Ordering::SeqCst) {
                return false;
            }
            match (&*master).write(bytes) {
                Ok(0) => return false,
                Ok(written) => bytes = &bytes[written..],
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if poll(master.as_raw_fd(), libc::POLLOUT).is_err() {
                        return false;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return false,
            }
        }
        true
    }
}
