//! `process`: a long-lived program with plain pipes, for programs that speak a protocol on stdin and stdout (an MCP
//! server). Unlike `exec`, the program reads input (`processWrite`, `processCloseStdin`, addressed by the `process`
//! request's id) and output is raw bytes per stream; unlike `pty`, nothing is echoed, translated or merged.

use crate::errors::Failure;
use crate::exec::{
    Control, Ending, Groups, Launch, Message, kill_group, running, spawn, spawn_reader,
    start_waiter,
};
use crate::frame::{EVENT, Frame};
use crate::output::{Gate, Output};
use crate::sys;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// After the program exits, output still arriving is collected until this much silence, as for `exec`.
const EXIT_STDIO_GRACE: Duration = Duration::from_millis(100);

/// Input for a program's stdin, in arrival order.
enum Input {
    Data(Vec<u8>),
    Close,
}

/// What `processWrite` and `processCloseStdin` reach: the stdin of one running `process` request.
pub struct Process {
    input: Sender<Input>,
}

/// Running programs by the id of their `process` request.
pub type Processes = Arc<Mutex<HashMap<u32, Arc<Process>>>>;

pub struct ProcessRequest {
    argv: Vec<String>,
    cwd: String,
    env: Map<String, Value>,
    inherit_env: bool,
}

impl ProcessRequest {
    pub fn from_json(json: &Value) -> Result<ProcessRequest, Failure> {
        Ok(ProcessRequest {
            argv: crate::exec::argv(json)?
                .ok_or_else(|| Failure::new("EINVAL", "process needs argv"))?,
            cwd: json["cwd"]
                .as_str()
                .ok_or_else(|| Failure::new("EINVAL", "process needs cwd"))?
                .to_string(),
            env: json["env"].as_object().cloned().unwrap_or_default(),
            inherit_env: json["inheritEnv"].as_bool().unwrap_or(true),
        })
    }
}

/// Queue input for the program's stdin; it is written in the order it arrives, without holding up other requests.
pub fn write(processes: &Processes, json: &Value, payload: Vec<u8>) -> Result<Value, Failure> {
    running(processes, json, "process")?
        .input
        .send(Input::Data(payload))
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Close the program's stdin once the input queued before has been written.
pub fn close_stdin(processes: &Processes, json: &Value) -> Result<Value, Failure> {
    running(processes, json, "process")?
        .input
        .send(Input::Close)
        .map_err(|_| Failure::new("EBADF", "the program's stdin is closed"))?;
    Ok(json!({}))
}

/// Run the program, sending a `started` event and then its output, until it exits.
pub fn run(
    id: u32,
    request: ProcessRequest,
    output: &Arc<Output>,
    control: &Control,
    groups: &Groups,
    processes: &Processes,
) -> Result<Value, Failure> {
    let (sender, receiver) = mpsc::channel();
    control.attach(sender.clone());
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    let program = sys::resolve_program(&request.argv[0], &request.cwd, &request.env)?;
    if !Path::new(&request.cwd).exists() {
        return Err(Failure::new(
            "spawn_error",
            format!("Working directory does not exist: {}", request.cwd),
        ));
    }
    let launch = Launch {
        cwd: &request.cwd,
        env: &request.env,
        inherit_env: request.inherit_env,
    };
    let mut child = spawn(&program, &request.argv[1..], &launch, Stdio::piped())
        .map_err(|error| Failure::new("spawn_error", error.to_string()))?;
    let pid = child.id();
    groups.lock().unwrap().insert(pid);
    let stop = Arc::new(AtomicBool::new(false));
    // A thread that cannot start (a task limit) fails the request; the started program is killed and reaped. Threads
    // already running see `stop` within 100 ms.
    let abandon = |mut child: Child, error: std::io::Error| {
        stop.store(true, Ordering::SeqCst);
        kill_group(pid);
        // On Windows the group kill spawns taskkill, which can fail under the same limit; kill the child directly.
        let _ = child.kill();
        let _ = child.wait();
        groups.lock().unwrap().remove(&pid);
        Failure::new("spawn_error", error.to_string())
    };
    // What the program starts in its group dies when it exits: a wrapper such as `npx` that exits does not leave the
    // server it started running, out of reach of `close()` and of a lost connection.
    let group = match sys::group(&child) {
        Ok(group) => group,
        Err(error) => return Err(abandon(child, error)),
    };
    // Like a full pipe: a program that writes faster than the link waits.
    let gate = Gate::new(output);
    let stdout = child.stdout.take().unwrap();
    if let Err(error) = spawn_reader(0, stdout, sender.clone(), stop.clone(), Some(gate.clone())) {
        return Err(abandon(child, error));
    }
    let stderr = child.stderr.take().unwrap();
    if let Err(error) = spawn_reader(1, stderr, sender.clone(), stop.clone(), Some(gate.clone())) {
        return Err(abandon(child, error));
    }
    let (input, inputs) = mpsc::channel::<Input>();
    let mut stdin = child.stdin.take().unwrap();
    let started = {
        let stop = stop.clone();
        thread::Builder::new().spawn(move || {
            for input in inputs {
                match input {
                    Input::Data(bytes) => {
                        if !sys::write_pipe(&mut stdin, &bytes, &stop) {
                            return;
                        }
                    }
                    // Returning drops stdin, which closes it; later input fails with `EBADF`.
                    Input::Close => return,
                }
            }
        })
    };
    if let Err(error) = started {
        return Err(abandon(child, error));
    }
    if let Err((child, error)) = start_waiter(
        child,
        Some(Ending {
            group,
            groups: groups.clone(),
        }),
        sender.clone(),
    ) {
        return Err(abandon(child, error));
    }
    drop(sender);
    // Registered before `started` goes out, so input sent after it always finds the program.
    processes
        .lock()
        .unwrap()
        .insert(id, Arc::new(Process { input }));
    output.control(Frame::new(
        EVENT,
        id,
        json!({ "kind": "started", "pid": pid }),
    ));

    let names = ["stdout", "stderr"];
    let mut ended = [false, false];
    let mut status: Option<Result<ExitStatus, String>> = None;
    let mut idle_until: Option<Instant> = None;
    let mut aborted = false;
    let mut killed = false;
    let kill = |killed: &mut bool| {
        if !*killed {
            *killed = true;
            // Only while the program is in `groups`: the waiter removes it under this lock before reaping it.
            let groups = groups.lock().unwrap();
            if groups.contains(&pid) {
                kill_group(pid);
            }
        }
    };
    if control.killed.load(Ordering::SeqCst) {
        kill(&mut killed);
    }
    loop {
        if status.is_some() && ended[0] && ended[1] {
            break;
        }
        let wait = match idle_until {
            Some(idle) => {
                let now = Instant::now();
                if now < idle {
                    idle - now
                } else if gate.held() {
                    // Silence while the link holds a reader up is not the end of the output: the pipe may hold more.
                    idle_until = Some(now + EXIT_STDIO_GRACE);
                    EXIT_STDIO_GRACE
                } else {
                    // A descendant may hold the pipes open after the program exited; stop waiting for it.
                    break;
                }
            }
            None => Duration::from_secs(3600),
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Data(stream, bytes)) => {
                output.bulk(
                    Frame::with_payload(
                        EVENT,
                        id,
                        json!({ "kind": "output", "stream": names[stream] }),
                        bytes,
                    ),
                    None,
                );
                if status.is_some() {
                    idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
                }
            }
            Ok(Message::Eof(stream)) => ended[stream] = true,
            Ok(Message::Exit(exit)) => {
                // The waiter already ended the group; nothing is left to kill.
                killed = true;
                status = Some(Ok(exit));
                idle_until = Some(Instant::now() + EXIT_STDIO_GRACE);
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
    // Readers and the writer stop within 100 ms, also when a descendant still holds a pipe; removing the program
    // drops its input channel, which ends a writer waiting for input.
    stop.store(true, Ordering::SeqCst);
    processes.lock().unwrap().remove(&id);
    groups.lock().unwrap().remove(&pid);
    if aborted {
        return Err(Failure::new("aborted", "aborted"));
    }
    match status {
        Some(Ok(status)) => Ok(json!({ "exitCode": sys::exit_code(status) })),
        Some(Err(error)) => Err(Failure::new("spawn_error", error)),
        None => Err(Failure::new(
            "spawn_error",
            "process did not report its exit",
        )),
    }
}
