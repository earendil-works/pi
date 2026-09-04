use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use tokio::process::Command;

pub struct PackageManager {
    agent_dir: PathBuf,
    cwd: PathBuf,
}
impl PackageManager {
    #[must_use]
    pub fn new(agent_dir: PathBuf, cwd: PathBuf) -> Self {
        Self { agent_dir, cwd }
    }
    fn settings_path(&self, local: bool) -> PathBuf {
        if local {
            self.cwd.join(".pi/settings.json")
        } else {
            self.agent_dir.join("settings.json")
        }
    }
    #[must_use]
    pub fn resolve_source(&self, source: &str, local: bool) -> PathBuf {
        let root = if local {
            self.cwd.join(".pi")
        } else {
            self.agent_dir.clone()
        };
        if source.starts_with("npm:") {
            let spec = source.trim_start_matches("npm:");
            let split = spec.rfind('@').filter(|position| {
                *position > 0 && (!spec.starts_with('@') || *position > spec.find('/').unwrap_or(usize::MAX))
            });
            let name = split.map_or(spec, |position| &spec[..position]);
            root.join("npm").join(name.trim_start_matches('@').replace('/', "__"))
        } else if source.starts_with("git:") || source.contains("://") {
            git_path(source, &root)
        } else {
            let path = PathBuf::from(source);
            if path.is_absolute() { path } else { self.cwd.join(path) }
        }
    }

    pub async fn list(&self, local: bool) -> Result<Vec<Value>> {
        let settings = read_json(&self.settings_path(local)).await?;
        Ok(settings
            .get("packages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
    pub async fn install(&self, source: &str, local: bool) -> Result<PathBuf> {
        let root = if local {
            self.cwd.join(".pi")
        } else {
            self.agent_dir.clone()
        };
        let installed = if source.starts_with("git:")
            || source.starts_with("https://")
            || source.starts_with("ssh://")
            || source.starts_with("git://")
        {
            install_git(source, &root).await?
        } else if source.starts_with("npm:") {
            install_npm(source, &root).await?
        } else {
            let path = PathBuf::from(source);
            if path.is_absolute() { path } else { self.cwd.join(path) }
        };
        let path = self.settings_path(local);
        let mut settings = read_json(&path).await?;
        let packages = settings
            .as_object_mut()
            .ok_or_else(|| anyhow!("settings must be an object"))?
            .entry("packages")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("settings packages must be an array"))?;
        if !packages.iter().any(|entry| entry.as_str() == Some(source)) {
            packages.push(json!(source));
        }
        write_json(&path, &settings).await?;
        Ok(installed)
    }
    pub async fn remove(&self, source: &str, local: bool) -> Result<()> {
        let path = self.settings_path(local);
        let mut settings = read_json(&path).await?;
        if let Some(packages) = settings.get_mut("packages").and_then(Value::as_array_mut) {
            packages.retain(|entry| {
                entry.as_str() != Some(source) && entry.get("source").and_then(Value::as_str) != Some(source)
            });
        }
        write_json(&path, &settings).await
    }
    pub async fn update(&self, source: Option<&str>, local: bool) -> Result<()> {
        for package in self.list(local).await? {
            let current = package
                .as_str()
                .or_else(|| package.get("source").and_then(Value::as_str));
            if source.is_some() && current != source {
                continue;
            }
            if let Some(current) = current
                && current.starts_with("git:")
            {
                let root = if local {
                    self.cwd.join(".pi")
                } else {
                    self.agent_dir.clone()
                };
                let path = git_path(current, &root);
                if path.join(".git").exists() {
                    run(Command::new("git")
                        .arg("-C")
                        .arg(&path)
                        .args(["fetch", "--all", "--tags", "--prune"]))
                    .await?;
                }
            }
        }
        Ok(())
    }
}

async fn read_json(path: &Path) -> Result<Value> {
    match tokio::fs::read(path).await {
        Ok(data) => Ok(serde_json::from_slice(&data)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error.into()),
    }
}
async fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?
    }
    tokio::fs::write(path, serde_json::to_vec_pretty(value)?).await?;
    Ok(())
}
async fn install_git(source: &str, root: &Path) -> Result<PathBuf> {
    let path = git_path(source, root);
    if path.exists() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?
    }
    let (raw, reference) = split_git_ref(source);
    let url = normalize_git_url(raw);
    run(Command::new("git")
        .args(["clone", "--filter=blob:none"])
        .arg(&url)
        .arg(&path))
    .await?;
    if let Some(reference) = reference {
        run(Command::new("git").arg("-C").arg(&path).args(["checkout", reference])).await?
    }
    Ok(path)
}
fn split_git_ref(source: &str) -> (&str, Option<&str>) {
    let raw = source.strip_prefix("git:").unwrap_or(source);
    let position = raw
        .rfind('@')
        .filter(|position| *position > raw.find('/').unwrap_or(0) && !raw[..*position].ends_with("git"));
    position.map_or((raw, None), |position| (&raw[..position], Some(&raw[position + 1..])))
}
fn normalize_git_url(raw: &str) -> String {
    if raw.contains("://") || raw.starts_with("git@") {
        raw.into()
    } else {
        format!("https://{raw}")
    }
}
fn git_path(source: &str, root: &Path) -> PathBuf {
    let (raw, _) = split_git_ref(source);
    let clean = raw
        .trim_start_matches("git:")
        .trim_end_matches(".git")
        .replace([':', '@'], "/");
    root.join("git").join(
        clean
            .trim_start_matches("https://")
            .trim_start_matches("ssh://")
            .trim_start_matches('/'),
    )
}
async fn install_npm(source: &str, root: &Path) -> Result<PathBuf> {
    let spec = source.trim_start_matches("npm:");
    let split = spec.rfind('@').filter(|position| {
        *position > 0 && (!spec.starts_with('@') || *position > spec.find('/').unwrap_or(usize::MAX))
    });
    let (name, requested) = split.map_or((spec, None), |position| {
        (&spec[..position], Some(&spec[position + 1..]))
    });
    let encoded_name: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    let metadata: Value = reqwest::Client::new()
        .get(format!("https://registry.npmjs.org/{encoded_name}"))
        .header("accept", "application/vnd.npm.install-v1+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let version = requested
        .map(str::to_owned)
        .or_else(|| {
            metadata
                .pointer("/dist-tags/latest")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| anyhow!("npm package has no latest version: {name}"))?;
    let manifest = metadata
        .get("versions")
        .and_then(|versions| versions.get(&version))
        .ok_or_else(|| anyhow!("npm package version not found: {name}@{version}"))?;
    let tarball = manifest
        .pointer("/dist/tarball")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("npm package omitted dist.tarball"))?;
    let archive = reqwest::get(tarball).await?.error_for_status()?.bytes().await?.to_vec();
    let target = root.join("npm").join(name.trim_start_matches('@').replace('/', "__"));
    if tokio::fs::try_exists(&target).await? {
        tokio::fs::remove_dir_all(&target).await?;
    }
    tokio::fs::create_dir_all(&target).await?;
    let unpack_target = target.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let decoder = flate2::read::GzDecoder::new(archive.as_slice());
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.strip_prefix("package").map(Path::to_owned)?;
            if path.as_os_str().is_empty() {
                continue;
            }
            if path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err(anyhow!("unsafe npm archive path"));
            }
            let destination = unpack_target.join(path);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&destination)?;
        }
        Ok(())
    })
    .await??;
    Ok(target)
}
async fn run(command: &mut Command) -> Result<()> {
    let output = command.output().await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow!("command failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}
