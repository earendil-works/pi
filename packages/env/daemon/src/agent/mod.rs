//! `pi-env agent` and its setup commands (docs/agent.md): a machine enrolled with Radius that serves pi-env sessions
//! and port forwards to its owner through the relay, kept running by a user service.
//!
//! - `install`: copy this binary into the state directory, enroll, and install and start the service.
//! - `enroll`: enrollment only, by code or through the device flow.
//! - `agent`: the relay host itself, what the service runs.
//! - `status`, `uninstall`.

mod channel;
mod forwards;
mod http;
mod log;
#[cfg(unix)]
mod login_env;
mod net;
mod oauth;
mod proxy;
mod relay;
mod service;
mod state;
mod ws;

pub use forwards::Forwards;

use net::Origin;
use relay::{Agent, Tokens};
use serde_json::{Value, json};
use state::{AgentConfig, Credentials, State};
use std::io::Read;
use std::sync::{Arc, Mutex};

const DEFAULT_GATEWAY: &str = "https://radius.pi.dev";

const USAGE: &str = "usage:
  pi-env install [--gateway URL] [--code CODE | --code-stdin] [--name NAME] [--state DIR] [--no-service]
                 [--service-name NAME]
  pi-env enroll [--gateway URL] [--code CODE | --code-stdin] [--name NAME] [--state DIR]
  pi-env agent [--state DIR]
  pi-env status [--state DIR]
  pi-env uninstall [--state DIR] [--keep-state]";

/// Run `pi-env <command> <args>`; returns the exit code.
pub fn main(command: &str, args: &[String]) -> i32 {
    let options = match Options::parse(command, args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("pi-env {command}: {error}\n{USAGE}");
            return 2;
        }
    };
    let result = match command {
        "agent" => run_agent(&options),
        "install" => install(&options),
        "enroll" => enroll(&options).map(|config| println!("{}", enrollment_json(&config, None))),
        "status" => {
            println!("{}", status(&options.state));
            Ok(())
        }
        _ => uninstall(&options),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("pi-env {command}: {error}");
            1
        }
    }
}

struct Options {
    state: State,
    gateway: Option<String>,
    code: Option<String>,
    name: Option<String>,
    no_service: bool,
    keep_state: bool,
    service_name: Option<String>,
}

impl Options {
    fn parse(command: &str, args: &[String]) -> Result<Options, String> {
        let allowed: &[&str] = match command {
            "install" => &[
                "--gateway",
                "--code",
                "--code-stdin",
                "--name",
                "--state",
                "--no-service",
                "--service-name",
            ],
            "enroll" => &["--gateway", "--code", "--code-stdin", "--name", "--state"],
            "uninstall" => &["--state", "--keep-state"],
            _ => &["--state"],
        };
        let mut state = None;
        let mut options = Options {
            state: State::new(None),
            gateway: None,
            code: None,
            name: None,
            no_service: false,
            keep_state: false,
            service_name: None,
        };
        let mut code_stdin = false;
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            if !allowed.contains(&arg.as_str()) {
                return Err(format!("unknown option {arg}"));
            }
            let mut value = || {
                rest.next()
                    .cloned()
                    .ok_or_else(|| format!("{arg} needs a value"))
            };
            match arg.as_str() {
                "--state" => state = Some(value()?),
                "--gateway" => options.gateway = Some(value()?),
                "--code" => options.code = Some(value()?),
                "--name" => options.name = Some(value()?).filter(|name| !name.trim().is_empty()),
                "--service-name" => options.service_name = Some(value()?),
                "--code-stdin" => code_stdin = true,
                "--no-service" => options.no_service = true,
                _ => options.keep_state = true,
            }
        }
        if code_stdin {
            if options.code.is_some() {
                return Err("--code and --code-stdin exclude each other".into());
            }
            let mut code = String::new();
            std::io::stdin()
                .read_to_string(&mut code)
                .map_err(|error| format!("reading the code from stdin: {error}"))?;
            options.code = Some(code.trim().to_string()).filter(|code| !code.is_empty());
        }
        options.state = State::new(state.as_deref());
        Ok(options)
    }
}

/// Enroll unless already enrolled with this gateway. A code always enrolls anew (see `redeem`); the device flow enrolls
/// a new machine.
fn enroll(options: &Options) -> Result<AgentConfig, String> {
    let state = &options.state;
    let existing = state.agent()?;
    let gateway = options
        .gateway
        .clone()
        .or_else(|| existing.as_ref().map(|config| config.gateway.clone()))
        .unwrap_or_else(|| DEFAULT_GATEWAY.into());
    let origin = Origin::parse(&gateway)?;
    let gateway = origin.text();
    if let Some(mut config) = existing.clone()
        && options.code.is_none()
        && config.gateway == gateway
        && state.credentials()?.is_some()
    {
        if options.name.is_some() && options.name != config.name {
            config.name = options.name.clone();
            state.write_agent(&config)?;
        }
        return Ok(config);
    }
    let name = options
        .name
        .clone()
        .or_else(|| existing.as_ref().and_then(|config| config.name.clone()));
    let known = existing
        .as_ref()
        .filter(|config| config.gateway == gateway)
        .map(|config| config.server_id.clone());
    let (server_id, grant) = match &options.code {
        Some(code) => redeem(&origin, code, known, name.as_deref())?,
        None => {
            let server_id = new_server_id();
            let grant = oauth::device_flow(&origin, &server_id, |url, code| {
                eprintln!(
                    "To register this machine with Radius, open {url} and confirm the code {code}"
                );
            })
            .map_err(|error| format!("enrollment: {error}"))?;
            (server_id, grant)
        }
    };
    let (Some(organization_id), Some(principal_id), Some(refresh_token)) = (
        grant.organization_id.clone(),
        grant.principal_id.clone(),
        grant.refresh_token.clone(),
    ) else {
        return Err("enrollment: the token response lacks the owner or a refresh token".into());
    };
    std::fs::create_dir_all(&state.dir)
        .map_err(|error| format!("{}: {error}", state.dir.display()))?;
    state.write_credentials(&Credentials {
        access_token: grant.access_token.clone(),
        refresh_token,
        expires_at: log::now_ms() + grant.expires_in * 1000,
    })?;
    let config = AgentConfig {
        gateway,
        server_id: grant.server_id.clone().unwrap_or(server_id),
        organization_id,
        principal_id,
        public_origin: grant.public_origin.clone(),
        name,
        service: existing.and_then(|config| config.service),
    };
    state.write_agent(&config)?;
    Ok(config)
}

/// Redeem an enrollment code: with the machine's `known` server ID if it has one, else a new one. A re-enroll code is
/// bound to one machine and names it when the ID differs (`server_id_mismatch`): redeem again with that ID. An
/// ordinary code enrolls new machines only and refuses a known ID (`server_id_claimed`): redeem again with a new one,
/// which makes this a new machine.
fn redeem(
    origin: &Origin,
    code: &str,
    known: Option<String>,
    name: Option<&str>,
) -> Result<(String, oauth::Grant), String> {
    let mut fresh = known.is_none();
    let mut server_id = known.unwrap_or_else(new_server_id);
    // Each answer leads to at most one other ID: a mismatch names the bound one, a claim asks for a new one.
    for _ in 0..3 {
        match oauth::redeem_code(origin, code, &server_id, name) {
            Ok(grant) => return Ok((server_id, grant)),
            Err(oauth::TokenError::Claimed) if !fresh => {
                let new = new_server_id();
                eprintln!(
                    "The code enrolls a new machine: the server ID changes from {server_id} to {new}"
                );
                server_id = new;
                fresh = true;
            }
            Err(oauth::TokenError::Mismatch(bound)) if bound != server_id => server_id = bound,
            Err(error) => return Err(format!("enrollment: {error}")),
        }
    }
    Err("enrollment: the gateway kept refusing the server ID".into())
}

fn install(options: &Options) -> Result<(), String> {
    let state = &options.state;
    let mut config = enroll(options)?;
    if let Some(record) = &config.service {
        // A running agent holds the old binary (on Windows it cannot be replaced while it runs).
        service::stop(state, record);
    }
    copy_binary(state)?;
    let installed = if options.no_service {
        service::Installed {
            record: state::ServiceRecord {
                kind: service::NONE.into(),
                name: "pi-env".into(),
            },
            notes: service::manual_notes(state),
        }
    } else {
        service::install(state, options.service_name.as_deref())?
    };
    for note in &installed.notes {
        eprintln!("{note}");
    }
    config.service = Some(installed.record.clone());
    state.write_agent(&config)?;
    println!("{}", enrollment_json(&config, Some(&installed.record.kind)));
    Ok(())
}

/// Copy the running binary to `<state>/bin/pi-env`, through a new file: a running binary is never written over.
fn copy_binary(state: &State) -> Result<(), String> {
    let source =
        std::env::current_exe().map_err(|error| format!("finding this binary: {error}"))?;
    let target = state.binary();
    let same = |a: &std::path::Path, b: &std::path::Path| match (a.canonicalize(), b.canonicalize())
    {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same(&source, &target) {
        return Ok(());
    }
    let directory = target.parent().unwrap();
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?;
    let temporary = target.with_extension("new");
    let copied = std::fs::copy(&source, &temporary).and_then(|_| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&temporary, &target)
    });
    copied.map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("installing {}: {error}", target.display())
    })
}

fn enrollment_json(config: &AgentConfig, service: Option<&str>) -> Value {
    let mut value = json!({
        "server_id": config.server_id,
        "organization_id": config.organization_id,
        "public_origin": config.public_origin,
    });
    if let Some(service) = service {
        value["service"] = json!(service);
    }
    value
}

fn status(state: &State) -> Value {
    let config = state.agent().ok().flatten();
    let enrolled = config.is_some() && state.credentials().ok().flatten().is_some();
    let service = config
        .as_ref()
        .and_then(|config| config.service.as_ref())
        .map(|record| {
            json!({
                "kind": record.kind,
                "name": record.name,
                "state": service::status(state, record),
            })
        });
    json!({
        "enrolled": enrolled,
        "stateDir": state.dir,
        "serverId": config.as_ref().map(|config| &config.server_id),
        "organizationId": config.as_ref().map(|config| &config.organization_id),
        "gateway": config.as_ref().map(|config| &config.gateway),
        "name": config.as_ref().and_then(|config| config.name.as_ref()),
        "publicOrigin": config.as_ref().and_then(|config| config.public_origin.as_ref()),
        "service": service,
        "relay": state.status(),
    })
}

fn uninstall(options: &Options) -> Result<(), String> {
    let state = &options.state;
    if let Some(record) = state.agent()?.and_then(|config| config.service) {
        service::uninstall(state, &record)?;
    }
    if !options.keep_state {
        match std::fs::remove_dir_all(&state.dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("removing {}: {error}", state.dir.display()));
            }
            _ => {}
        }
    }
    println!(
        "{}",
        json!({ "uninstalled": true, "stateRemoved": !options.keep_state })
    );
    Ok(())
}

fn run_agent(options: &Options) -> Result<(), String> {
    let state = options.state.clone();
    // First, while no other thread runs: changing the environment is not thread-safe, and threads inherit the
    // signal mask the exit handler sets.
    #[cfg(unix)]
    let login = login_env::adopt();
    let config = state
        .agent()?
        .ok_or("not enrolled: run pi-env install or pi-env enroll first")?;
    let credentials = state
        .credentials()?
        .ok_or("no credentials.json: enroll again")?;
    let agent = Arc::new(Agent {
        gateway: Origin::parse(&config.gateway)?,
        tokens: Tokens::new(state.clone(), Origin::parse(&config.gateway)?, credentials),
        forwards: Arc::new(Forwards::open(
            state.path("forwards.json"),
            config.public_origin.clone(),
        )?),
        sessions: Mutex::new(Vec::new()),
        state: state.clone(),
        config,
    });
    {
        let agent = agent.clone();
        // Stopping the agent (the service manager's SIGTERM) leaves no command of any session running.
        crate::sys::on_exit_signal(move |signal| {
            for groups in agent.sessions.lock().unwrap().iter() {
                crate::kill_all(groups);
            }
            std::process::exit(128 + signal);
        });
    }
    log::open(state.path("agent.log"));
    log::line(&format!(
        "pi-env agent {} for server {} at {}",
        crate::VERSION,
        agent.config.server_id,
        agent.config.gateway
    ));
    #[cfg(unix)]
    match login {
        Ok(count) => log::line(&format!(
            "adopted {count} variables of the login environment"
        )),
        Err(error) => log::line(&format!("keeping the service environment: {error}")),
    }
    relay::run(agent)
}

/// A random UUIDv4 for a new server, lowercase.
fn new_server_id() -> String {
    let mut bytes = random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `count` bytes from the system's secure random source.
pub fn random_bytes(count: usize) -> Vec<u8> {
    use ring::rand::SecureRandom;
    let mut bytes = vec![0u8; count];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system random source works");
    bytes
}

/// This machine's host name, the name a machine without a configured one connects with.
pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: gethostname writes at most `buffer.len()` bytes into the buffer.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            let name = String::from_utf8_lossy(&buffer[..end]).into_owned();
            if !name.is_empty() {
                return name;
            }
        }
    }
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "pi-env".into())
}
