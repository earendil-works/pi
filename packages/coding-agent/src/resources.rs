use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use regex::Regex;
use serde::Deserialize;
use tokio::fs;
use walkdir::WalkDir;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptTemplate {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub content: String,
    pub path: PathBuf,
}
impl PromptTemplate {
    pub fn expand(&self, input: &str) -> String {
        let args = shell_words::split(input).unwrap_or_else(|_| input.split_whitespace().map(str::to_owned).collect());
        expand_arguments(&self.content, &args)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub base_dir: PathBuf,
    pub disable_model_invocation: bool,
}
#[derive(Clone, Debug)]
pub struct Theme {
    pub name: String,
    pub path: PathBuf,
    pub value: serde_json::Value,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextFile {
    pub path: PathBuf,
    pub content: String,
}
#[derive(Clone, Debug, Default)]
pub struct ResourceDiagnostics {
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}
#[derive(Clone, Debug, Default)]
pub struct Resources {
    pub prompts: Vec<PromptTemplate>,
    pub skills: Vec<Skill>,
    pub themes: Vec<Theme>,
    pub context_files: Vec<ContextFile>,
    pub extension_paths: Vec<PathBuf>,
    pub diagnostics: ResourceDiagnostics,
}

pub struct ResourceLoader {
    cwd: PathBuf,
    agent_dir: PathBuf,
    trusted: bool,
    additional_prompts: Vec<PathBuf>,
    additional_skills: Vec<PathBuf>,
    additional_themes: Vec<PathBuf>,
    additional_extensions: Vec<PathBuf>,
    package_paths: Vec<PathBuf>,
}
impl ResourceLoader {
    #[must_use]
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>, trusted: bool) -> Self {
        Self {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
            trusted,
            additional_prompts: Vec::new(),
            additional_skills: Vec::new(),
            additional_themes: Vec::new(),
            additional_extensions: Vec::new(),
            package_paths: Vec::new(),
        }
    }
    pub fn add_prompt_path(&mut self, path: PathBuf) {
        self.additional_prompts.push(path)
    }
    pub fn add_skill_path(&mut self, path: PathBuf) {
        self.additional_skills.push(path)
    }
    pub fn add_theme_path(&mut self, path: PathBuf) {
        self.additional_themes.push(path)
    }
    pub fn add_extension_path(&mut self, path: PathBuf) {
        self.additional_extensions.push(path)
    }
    pub fn add_package_path(&mut self, path: PathBuf) {
        self.package_paths.push(path)
    }
    pub async fn load(&self) -> Resources {
        let mut resources = Resources::default();
        let mut prompt_paths = vec![self.agent_dir.join("prompts")];
        let mut skill_paths = vec![self.agent_dir.join("skills")];
        let mut theme_paths = vec![self.agent_dir.join("themes")];
        let mut extension_paths = vec![self.agent_dir.join("extensions")];
        if let Some(home) = self.agent_dir.parent().and_then(Path::parent) {
            skill_paths.push(home.join(".agents/skills"))
        }
        if self.trusted {
            prompt_paths.push(self.cwd.join(".pi/prompts"));
            skill_paths.push(self.cwd.join(".pi/skills"));
            theme_paths.push(self.cwd.join(".pi/themes"));
            extension_paths.push(self.cwd.join(".pi/extensions"));
            for ancestor in self.cwd.ancestors() {
                skill_paths.push(ancestor.join(".agents/skills"));
                if ancestor.join(".git").exists() {
                    break;
                }
            }
        }
        prompt_paths.extend(self.additional_prompts.clone());
        skill_paths.extend(self.additional_skills.clone());
        theme_paths.extend(self.additional_themes.clone());
        extension_paths.extend(self.additional_extensions.clone());
        for package in &self.package_paths {
            let manifest = fs::read(package.join("package.json"))
                .await
                .ok()
                .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok());
            let configured = |kind: &str| {
                manifest
                    .as_ref()
                    .and_then(|value| value.pointer(&format!("/pi/{kind}")))
                    .and_then(serde_json::Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .filter(|value| !value.starts_with(['!', '-']))
                            .map(|value| package.join(value.trim_start_matches('+')))
                            .collect::<Vec<_>>()
                    })
            };
            extension_paths.extend(configured("extensions").unwrap_or_else(|| vec![package.join("extensions")]));
            skill_paths.extend(configured("skills").unwrap_or_else(|| vec![package.join("skills")]));
            prompt_paths.extend(configured("prompts").unwrap_or_else(|| vec![package.join("prompts")]));
            theme_paths.extend(configured("themes").unwrap_or_else(|| vec![package.join("themes")]));
        }
        resources.prompts = load_prompts(&prompt_paths, &mut resources.diagnostics).await;
        resources.skills = load_skills(&skill_paths, &mut resources.diagnostics).await;
        resources.themes = load_themes(&theme_paths, &mut resources.diagnostics).await;
        resources.extension_paths = discover_files(&extension_paths, &["json"]);
        resources.context_files = load_context_files(&self.cwd, &self.agent_dir).await;
        resources
    }
}

async fn load_prompts(paths: &[PathBuf], diagnostics: &mut ResourceDiagnostics) -> Vec<PromptTemplate> {
    let mut result = Vec::new();
    let mut names = HashSet::new();
    for path in discover_files(paths, &["md"]) {
        match fs::read_to_string(&path).await {
            Ok(text) => {
                let (frontmatter, content) = frontmatter(&text);
                let metadata: Frontmatter = frontmatter
                    .as_deref()
                    .and_then(|value| serde_yaml::from_str(value).ok())
                    .unwrap_or_default();
                let name = path.file_stem().and_then(|x| x.to_str()).unwrap_or("prompt").to_owned();
                if !names.insert(name.clone()) {
                    diagnostics
                        .warnings
                        .push(format!("duplicate prompt template {name}: {}", path.display()));
                    continue;
                }
                let description = metadata.description.unwrap_or_else(|| {
                    content
                        .lines()
                        .find(|line| !line.trim().is_empty())
                        .unwrap_or("")
                        .trim()
                        .to_owned()
                });
                result.push(PromptTemplate {
                    name,
                    description,
                    argument_hint: metadata.argument_hint,
                    content,
                    path,
                });
            }
            Err(error) => diagnostics.errors.push(format!("{}: {error}", path.display())),
        }
    }
    result
}
async fn load_skills(paths: &[PathBuf], diagnostics: &mut ResourceDiagnostics) -> Vec<Skill> {
    let mut result = Vec::new();
    let mut names = HashSet::new();
    let mut files = Vec::new();
    for path in paths {
        if path.is_file() {
            files.push(path.clone())
        } else if path.is_dir() {
            for entry in WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file()
                    && (entry.file_name() == "SKILL.md"
                        || entry.path().extension().and_then(|x| x.to_str()) == Some("md"))
                {
                    files.push(entry.path().to_owned())
                }
            }
        }
    }
    files.sort();
    files.dedup();
    let valid = Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").expect("valid regex");
    for path in files {
        let Ok(text) = fs::read_to_string(&path).await else {
            continue;
        };
        let (Some(header), _) = frontmatter(&text) else {
            if path.file_name().and_then(|x| x.to_str()) == Some("SKILL.md") {
                diagnostics
                    .warnings
                    .push(format!("skill has no frontmatter: {}", path.display()))
            }
            continue;
        };
        let Ok(metadata) = serde_yaml::from_str::<Frontmatter>(&header) else {
            diagnostics
                .warnings
                .push(format!("invalid skill frontmatter: {}", path.display()));
            continue;
        };
        let Some(description) = metadata.description.filter(|x| !x.trim().is_empty()) else {
            diagnostics
                .warnings
                .push(format!("skill has no description: {}", path.display()));
            continue;
        };
        let name = metadata.name.unwrap_or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|x| x.to_str())
                .unwrap_or("skill")
                .to_owned()
        });
        if name.len() > 64 || !valid.is_match(&name) {
            diagnostics
                .warnings
                .push(format!("invalid skill name {name}: {}", path.display()))
        }
        if description.len() > 1024 {
            diagnostics
                .warnings
                .push(format!("skill description exceeds 1024 characters: {name}"))
        }
        if !names.insert(name.clone()) {
            diagnostics
                .warnings
                .push(format!("duplicate skill {name}: {}", path.display()));
            continue;
        }
        result.push(Skill {
            name,
            description,
            path: path.clone(),
            base_dir: path.parent().unwrap_or(Path::new(".")).to_owned(),
            disable_model_invocation: metadata.disable_model_invocation.unwrap_or(false),
        });
    }
    result
}
async fn load_themes(paths: &[PathBuf], diagnostics: &mut ResourceDiagnostics) -> Vec<Theme> {
    let mut result = Vec::new();
    for path in discover_files(paths, &["json"]) {
        match fs::read(&path)
            .await
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        {
            Some(value) => {
                let name = value
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| path.file_stem().and_then(|x| x.to_str()).map(str::to_owned));
                if let Some(name) = name {
                    result.push(Theme { name, path, value })
                }
            }
            None => diagnostics.warnings.push(format!("invalid theme: {}", path.display())),
        }
    }
    result
}
async fn load_context_files(cwd: &Path, agent_dir: &Path) -> Vec<ContextFile> {
    let mut paths = Vec::new();
    let global = agent_dir.join("AGENTS.md");
    if global.is_file() {
        paths.push(global)
    }
    let mut ancestors = cwd.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        let override_path = ancestor.join("AGENTS.override.md");
        if override_path.is_file() {
            paths.push(override_path)
        } else {
            let agents = ancestor.join("AGENTS.md");
            let claude = ancestor.join("CLAUDE.md");
            if agents.is_file() {
                paths.push(agents)
            } else if claude.is_file() {
                paths.push(claude)
            }
        }
    }
    let mut result = Vec::new();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path).await {
            result.push(ContextFile { path, content })
        }
    }
    result
}
fn discover_files(paths: &[PathBuf], extensions: &[&str]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths {
        if path.is_file() {
            files.push(path.clone())
        } else if path.is_dir() {
            for entry in WalkDir::new(path).max_depth(2).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|extension| extensions.contains(&extension))
                {
                    files.push(entry.path().to_owned())
                }
            }
        }
    }
    files.sort();
    files.dedup();
    files
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    argument_hint: Option<String>,
    disable_model_invocation: Option<bool>,
}
fn frontmatter(text: &str) -> (Option<String>, String) {
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, text.into());
    };
    let Some(end) = rest.find("\n---\n") else {
        return (None, text.into());
    };
    (Some(rest[..end].into()), rest[end + 5..].into())
}
fn expand_arguments(template: &str, args: &[String]) -> String {
    let all = args.join(" ");
    let re = Regex::new(r"\$\{(ARGUMENTS|@|\d+)(?::-(.*?))?\}|\$ARGUMENTS|\$@|\$(\d+)").expect("valid regex");
    re.replace_all(template, |captures: &regex::Captures<'_>| {
        let key = captures
            .get(1)
            .or_else(|| captures.get(3))
            .map_or("@", |matched| matched.as_str());
        let value = if matches!(key, "@" | "ARGUMENTS") {
            all.clone()
        } else {
            key.parse::<usize>()
                .ok()
                .and_then(|index| args.get(index.saturating_sub(1)))
                .cloned()
                .unwrap_or_default()
        };
        if value.is_empty() {
            captures
                .get(2)
                .map_or(String::new(), |default| default.as_str().to_owned())
        } else {
            value
        }
    })
    .into_owned()
}

#[must_use]
pub fn format_skills_prompt(skills: &[Skill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let body = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .map(|skill| {
            format!(
                "<skill><name>{}</name><description>{}</description><location>{}</location></skill>",
                skill.name,
                skill.description,
                skill.path.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n\n<available_skills>\n{body}\n</available_skills>")
}
#[must_use]
pub fn prompt_map(resources: &Resources) -> HashMap<&str, &PromptTemplate> {
    resources
        .prompts
        .iter()
        .map(|prompt| (prompt.name.as_str(), prompt))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expands_template_arguments() {
        let template = PromptTemplate {
            name: "x".into(),
            description: String::new(),
            argument_hint: None,
            content: "$1 / $@ / ${2:-fallback}".into(),
            path: PathBuf::new(),
        };
        assert_eq!(template.expand("one"), "one / one / fallback");
    }
}
