//! The user service that keeps `pi-env agent` running: a systemd user unit on Linux, a LaunchAgent on macOS, a
//! scheduled task at logon on Windows, a Termux:Boot script on Android; `none` where none of these exists, with
//! instructions to start the agent another way. Windows and Termux are not validated yet (docs/agent.md).

use super::state::{ServiceRecord, State};
use std::path::Path;
use std::process::{Command, Stdio};

/// The service `install` set up, and what the owner should know about it.
pub struct Installed {
    pub record: ServiceRecord,
    pub notes: Vec<String>,
}

/// The kinds `install` reports.
pub const NONE: &str = "none";
#[cfg(target_os = "linux")]
const SYSTEMD: &str = "systemd-user";
#[cfg(target_os = "macos")]
const LAUNCHD: &str = "launchd";
#[cfg(windows)]
const SCHTASKS: &str = "schtasks";
#[cfg(target_os = "android")]
const TERMUX: &str = "termux";

/// Install and start the service running `<state>/bin/pi-env agent --state <state>`, replacing one of the same name.
/// `name` is its label, unit, task or script name (default `dev.pi.env` for launchd, else `pi-env`).
pub fn install(state: &State, name: Option<&str>) -> Result<Installed, String> {
    platform::install(state, name)
}

/// Stop the service, so its binary can be replaced; it is started again by `install`.
pub fn stop(state: &State, record: &ServiceRecord) {
    match record.kind.as_str() {
        NONE => stop_process(state),
        _ => platform::stop(state, record),
    }
}

/// Stop and remove the service.
pub fn uninstall(state: &State, record: &ServiceRecord) -> Result<(), String> {
    match record.kind.as_str() {
        NONE => {
            stop_process(state);
            Ok(())
        }
        _ => platform::uninstall(state, record),
    }
}

/// `running`, `stopped`, `not_installed` or `unknown`.
pub fn status(state: &State, record: &ServiceRecord) -> &'static str {
    match record.kind.as_str() {
        NONE => {
            if agent_pid(state).is_some_and(alive) {
                "running"
            } else {
                "stopped"
            }
        }
        _ => platform::status(state, record),
    }
}

/// How to start the agent where no service manager is available.
pub fn manual_notes(state: &State) -> Vec<String> {
    let command = agent_command(state);
    if cfg!(windows) {
        return vec![format!("Start the agent with: {command}")];
    }
    vec![
        format!(
            "No user service manager found. Start the agent with: nohup {command} >/dev/null 2>&1 &"
        ),
        format!(
            "To start it at boot, add to your crontab (crontab -e): @reboot {command} >/dev/null 2>&1"
        ),
    ]
}

fn agent_command(state: &State) -> String {
    format!(
        "{} agent --state {}",
        quote(&state.binary().to_string_lossy()),
        quote(&state.dir.to_string_lossy())
    )
}

fn quote(text: &str) -> String {
    if cfg!(windows) {
        return format!("\"{text}\"");
    }
    if text
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"/._-+:@".contains(&byte))
    {
        return text.to_string();
    }
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The pid the running agent reported in `status.json`.
fn agent_pid(state: &State) -> Option<u32> {
    state
        .status()
        .and_then(|status| status["pid"].as_u64())
        .map(|pid| pid as u32)
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn alive(_pid: u32) -> bool {
    false
}

/// Stop an agent started without a service manager, by the pid it reported.
fn stop_process(state: &State) {
    #[cfg(unix)]
    if let Some(pid) = agent_pid(state).filter(|pid| alive(*pid) && *pid != std::process::id()) {
        // SAFETY: plain signal delivery to the agent's own process.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    let _ = state;
}

/// Run a command; its stdout, or an error with its stderr. (Termux needs no service manager.)
#[cfg(not(target_os = "android"))]
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "{program} {}: {}{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim()
        ))
    }
}

fn write(path: &Path, text: &[u8]) -> Result<(), String> {
    super::state::write_atomic(path, text, false)
        .map_err(|error| format!("{}: {error}", path.display()))
}

#[cfg(target_os = "macos")]
mod platform {
    //! A LaunchAgent in `~/Library/LaunchAgents`, loaded into the user's GUI domain (or the user domain without a
    //! GUI session, as over SSH).

    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    const DEFAULT_LABEL: &str = "dev.pi.env";

    pub fn install(state: &State, name: Option<&str>) -> Result<Installed, String> {
        let label = name.unwrap_or(DEFAULT_LABEL).to_string();
        let plist = plist_path(&label);
        let arguments = [
            state.binary().to_string_lossy().into_owned(),
            "agent".into(),
            "--state".into(),
            state.dir.to_string_lossy().into_owned(),
        ];
        let arguments: String = arguments
            .iter()
            .map(|argument| format!("\t\t<string>{}</string>\n", escape(argument)))
            .collect();
        let text = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\">\n<dict>\n\
             \t<key>Label</key>\n\t<string>{}</string>\n\
             \t<key>ProgramArguments</key>\n\t<array>\n{arguments}\t</array>\n\
             \t<key>RunAtLoad</key>\n\t<true/>\n\
             \t<key>KeepAlive</key>\n\t<true/>\n\
             \t<key>ThrottleInterval</key>\n\t<integer>5</integer>\n\
             </dict>\n</plist>\n",
            escape(&label)
        );
        write(&plist, text.as_bytes())?;
        let record = ServiceRecord {
            kind: LAUNCHD.into(),
            name: label,
        };
        bootout(&record.name);
        bootstrap(&plist)?;
        Ok(Installed {
            record,
            notes: Vec::new(),
        })
    }

    pub fn stop(_state: &State, record: &ServiceRecord) {
        bootout(&record.name);
    }

    pub fn uninstall(_state: &State, record: &ServiceRecord) -> Result<(), String> {
        bootout(&record.name);
        match std::fs::remove_file(plist_path(&record.name)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }

    pub fn status(_state: &State, record: &ServiceRecord) -> &'static str {
        for domain in domains() {
            if let Ok(output) = run(
                "launchctl",
                &["print", &format!("{domain}/{}", record.name)],
            ) {
                return if output.contains("state = running") {
                    "running"
                } else {
                    "stopped"
                };
            }
        }
        "not_installed"
    }

    fn plist_path(label: &str) -> PathBuf {
        PathBuf::from(crate::sys::home())
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"))
    }

    fn domains() -> [String; 2] {
        // SAFETY: getuid cannot fail.
        let uid = unsafe { libc::getuid() };
        [format!("gui/{uid}"), format!("user/{uid}")]
    }

    fn bootout(label: &str) {
        for domain in domains() {
            let _ = run("launchctl", &["bootout", &format!("{domain}/{label}")]);
        }
    }

    /// Load the agent into the GUI domain, else the user domain; a job just booted out may take a moment to go.
    fn bootstrap(plist: &Path) -> Result<(), String> {
        let plist = plist.to_string_lossy();
        let mut last = String::new();
        for _ in 0..20 {
            for domain in domains() {
                match run("launchctl", &["bootstrap", &domain, &plist]) {
                    Ok(_) => return Ok(()),
                    Err(error) => last = error,
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(last)
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! A systemd user unit; without systemd, kind `none` and instructions.

    use super::*;
    use std::path::PathBuf;

    const DEFAULT_NAME: &str = "pi-env";

    pub fn install(state: &State, name: Option<&str>) -> Result<Installed, String> {
        let name = name.unwrap_or(DEFAULT_NAME).to_string();
        if run("systemctl", &["--user", "show-environment"]).is_err() {
            return Ok(Installed {
                record: ServiceRecord {
                    kind: NONE.into(),
                    name,
                },
                notes: manual_notes(state),
            });
        }
        let text = format!(
            "[Unit]\nDescription=pi-env agent (Radius)\nAfter=network-online.target\nWants=network-online.target\n\n\
             [Service]\nExecStart={} agent --state {}\nRestart=always\nRestartSec=2\n\n\
             [Install]\nWantedBy=default.target\n",
            systemd_quote(&state.binary().to_string_lossy()),
            systemd_quote(&state.dir.to_string_lossy())
        );
        write(&unit_path(&name), text.as_bytes())?;
        let unit = format!("{name}.service");
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", &unit])?;
        run("systemctl", &["--user", "restart", &unit])?;
        let mut notes = Vec::new();
        let user = std::env::var("USER").unwrap_or_default();
        if let Err(error) = run("loginctl", &["enable-linger", &user]) {
            notes.push(format!(
                "Could not enable lingering ({error}): the agent runs only while you are logged in. \
                 Ask an administrator to run: loginctl enable-linger {user}"
            ));
        }
        Ok(Installed {
            record: ServiceRecord {
                kind: SYSTEMD.into(),
                name,
            },
            notes,
        })
    }

    pub fn stop(_state: &State, record: &ServiceRecord) {
        let _ = run(
            "systemctl",
            &["--user", "stop", &format!("{}.service", record.name)],
        );
    }

    pub fn uninstall(_state: &State, record: &ServiceRecord) -> Result<(), String> {
        let unit = format!("{}.service", record.name);
        let _ = run("systemctl", &["--user", "disable", "--now", &unit]);
        match std::fs::remove_file(unit_path(&record.name)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
        let _ = run("systemctl", &["--user", "daemon-reload"]);
        Ok(())
    }

    pub fn status(_state: &State, record: &ServiceRecord) -> &'static str {
        let unit = format!("{}.service", record.name);
        match run("systemctl", &["--user", "is-active", &unit]) {
            Ok(_) => "running",
            Err(_) if unit_path(&record.name).exists() => "stopped",
            Err(_) => "not_installed",
        }
    }

    fn unit_path(name: &str) -> PathBuf {
        let config = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(crate::sys::home()).join(".config"));
        config.join("systemd/user").join(format!("{name}.service"))
    }

    fn systemd_quote(text: &str) -> String {
        format!(
            "\"{}\"",
            text.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('%', "%%")
        )
    }
}

#[cfg(target_os = "android")]
mod platform {
    //! Termux: a Termux:Boot script that starts the agent at boot, and a start now.

    use super::*;
    use std::os::unix::process::CommandExt;
    use std::path::PathBuf;

    const DEFAULT_NAME: &str = "pi-env";

    pub fn install(state: &State, name: Option<&str>) -> Result<Installed, String> {
        let name = name.unwrap_or(DEFAULT_NAME).to_string();
        let script = script_path(&name);
        let text = format!(
            "#!/data/data/com.termux/files/usr/bin/sh\n\
             # Starts the pi-env agent at boot (needs the Termux:Boot app).\n\
             termux-wake-lock 2>/dev/null\n\
             nohup {} >/dev/null 2>&1 &\n",
            agent_command(state)
        );
        write(&script, text.as_bytes())?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
        }
        stop_process(state);
        let mut command = Command::new(state.binary());
        command
            .args(["agent", "--state"])
            .arg(&state.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only setsid between fork and exec: the agent outlives the installer's session.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        command
            .spawn()
            .map_err(|error| format!("starting the agent: {error}"))?;
        Ok(Installed {
            record: ServiceRecord {
                kind: TERMUX.into(),
                name,
            },
            notes: vec![
                "Install the Termux:Boot app and open it once, so the agent starts at boot.".into(),
            ],
        })
    }

    pub fn stop(state: &State, _record: &ServiceRecord) {
        stop_process(state);
    }

    pub fn uninstall(state: &State, record: &ServiceRecord) -> Result<(), String> {
        stop_process(state);
        match std::fs::remove_file(script_path(&record.name)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }

    pub fn status(state: &State, record: &ServiceRecord) -> &'static str {
        if agent_pid(state).is_some_and(alive) {
            "running"
        } else if script_path(&record.name).exists() {
            "stopped"
        } else {
            "not_installed"
        }
    }

    fn script_path(name: &str) -> PathBuf {
        PathBuf::from(crate::sys::home())
            .join(".termux/boot")
            .join(name)
    }
}

#[cfg(windows)]
mod platform {
    //! A scheduled task that starts the agent at logon of the current user and restarts it after failures.

    use super::*;

    const DEFAULT_NAME: &str = "pi-env";

    pub fn install(state: &State, name: Option<&str>) -> Result<Installed, String> {
        let name = name.unwrap_or(DEFAULT_NAME).to_string();
        let user = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default()
        );
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n\
             <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\r\n\
             <RegistrationInfo><Description>pi-env agent (Radius)</Description></RegistrationInfo>\r\n\
             <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>\r\n\
             <Principals><Principal id=\"Author\"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType>\
             <RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\r\n\
             <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\
             <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\
             <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\
             <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\
             <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>\
             <StartWhenAvailable>true</StartWhenAvailable><Hidden>true</Hidden></Settings>\r\n\
             <Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>agent --state \"{}\"</Arguments>\
             </Exec></Actions>\r\n</Task>\r\n",
            escape(&state.binary().to_string_lossy()),
            escape(&state.dir.to_string_lossy()),
            user = escape(&user),
        );
        // schtasks reads task XML as UTF-16 with a byte order mark.
        let mut bytes = vec![0xff, 0xfe];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let file = state.path("task.xml");
        write(&file, &bytes)?;
        let file = file.to_string_lossy();
        let _ = run("schtasks", &["/End", "/TN", &name]);
        run("schtasks", &["/Create", "/TN", &name, "/XML", &file, "/F"])?;
        run("schtasks", &["/Run", "/TN", &name])?;
        Ok(Installed {
            record: ServiceRecord {
                kind: SCHTASKS.into(),
                name,
            },
            notes: Vec::new(),
        })
    }

    pub fn stop(_state: &State, record: &ServiceRecord) {
        let _ = run("schtasks", &["/End", "/TN", &record.name]);
    }

    pub fn uninstall(state: &State, record: &ServiceRecord) -> Result<(), String> {
        let _ = run("schtasks", &["/End", "/TN", &record.name]);
        let _ = std::fs::remove_file(state.path("task.xml"));
        run("schtasks", &["/Delete", "/TN", &record.name, "/F"]).map(|_| ())
    }

    pub fn status(_state: &State, record: &ServiceRecord) -> &'static str {
        match run("schtasks", &["/Query", "/TN", &record.name, "/FO", "LIST"]) {
            Ok(output) if output.contains("Running") => "running",
            Ok(_) => "stopped",
            Err(_) => "not_installed",
        }
    }

    fn escape(text: &str) -> String {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    }
}
