//! The user's login environment for the agent: a service starts with a bare environment (launchd's PATH is
//! `/usr/bin:/bin:/usr/sbin:/sbin`), while commands of a session should see what an SSH login gives them. The agent
//! therefore runs the login shell once at startup, `$SHELL -l -c 'env -0'`, and takes its environment as its own.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long the login shell may take; a slower one leaves the agent's environment as it is.
const TIMEOUT: Duration = Duration::from_secs(10);
/// Printed before the environment, so whatever the login files print is skipped.
const MARKER: &str = "__PI_ENV_LOGIN_ENVIRONMENT__";

/// Replace this process's environment with the login shell's. Call before any other thread starts: changing the
/// environment is not thread-safe.
pub fn adopt() -> Result<usize, String> {
    let shell = login_shell();
    let variables = capture(&shell)?;
    let count = variables.len();
    let keep: std::collections::HashSet<&str> =
        variables.iter().map(|(key, _)| key.as_str()).collect();
    let stale: Vec<String> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| !keep.contains(key.as_str()))
        .collect();
    for key in stale {
        // SAFETY: no other thread runs yet (the caller's contract).
        unsafe { std::env::remove_var(key) };
    }
    for (key, value) in &variables {
        // SAFETY: as above.
        unsafe { std::env::set_var(key, value) };
    }
    Ok(count)
}

/// `SHELL`, else the user's shell in the password database, else `/bin/sh`.
fn login_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL")
        && !shell.is_empty()
    {
        return shell;
    }
    // SAFETY: getpwuid returns a pointer into static storage or null; it is read before any other call.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if !entry.is_null() && !(*entry).pw_shell.is_null() {
            let shell = std::ffi::CStr::from_ptr((*entry).pw_shell)
                .to_string_lossy()
                .into_owned();
            if !shell.is_empty() {
                return shell;
            }
        }
    }
    "/bin/sh".into()
}

fn capture(shell: &str) -> Result<Vec<(String, String)>, String> {
    let mut child = Command::new(shell)
        .args(["-l", "-c", &format!("printf '%s' {MARKER}; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("{shell}: {error}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{shell} -l took longer than {} s",
                    TIMEOUT.as_secs()
                ));
            }
        }
    }
    let bytes = reader.join().unwrap_or_default();
    parse(&bytes).ok_or_else(|| format!("{shell} -l printed no environment"))
}

/// The `KEY=VALUE` entries after the marker, NUL-separated.
fn parse(bytes: &[u8]) -> Option<Vec<(String, String)>> {
    let text = String::from_utf8_lossy(bytes);
    let (_, environment) = text.rsplit_once(MARKER)?;
    let variables: Vec<(String, String)> = environment
        .split('\0')
        .filter_map(|entry| entry.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !key.contains('\n'))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    (!variables.is_empty()).then_some(variables)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_environment_after_the_marker() {
        let output = format!("motd {MARKER} noise\n{MARKER}PATH=/a:/b\0MULTI=x\ny\0EMPTY=\0");
        assert_eq!(
            parse(output.as_bytes()).unwrap(),
            vec![
                ("PATH".to_string(), "/a:/b".to_string()),
                ("MULTI".to_string(), "x\ny".to_string()),
                ("EMPTY".to_string(), String::new()),
            ]
        );
        assert!(parse(b"PATH=/a\0").is_none());
    }

    #[test]
    fn captures_a_shell_environment() {
        let variables = capture("/bin/sh").unwrap();
        assert!(variables.iter().any(|(key, _)| key == "PATH"));
    }
}
