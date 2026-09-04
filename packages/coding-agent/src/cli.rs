use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Clone, Copy, Debug, Default, ValueEnum, PartialEq, Eq)]
pub enum OutputMode {
    #[default]
    Interactive,
    Print,
    Json,
    Rpc,
}
#[derive(Parser, Debug)]
#[command(
    name = "pi",
    version,
    about = "Minimal terminal coding agent, implemented in Rust",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
    #[arg(short = 'p', long = "print", conflicts_with = "mode")]
    pub print: bool,
    #[arg(long, value_enum, default_value = "interactive")]
    pub mode: OutputMode,
    #[arg(long)]
    pub provider: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long, env = "PI_API_KEY", hide_env_values = true)]
    pub api_key: Option<String>,
    #[arg(long)]
    pub thinking: Option<String>,
    #[arg(long, value_delimiter = ',')]
    pub models: Vec<String>,
    #[arg(long,num_args=0..=1,default_missing_value="")]
    pub list_models: Option<String>,
    #[arg(short = 'c', long = "continue")]
    pub continue_session: bool,
    #[arg(short = 'r', long)]
    pub resume: bool,
    #[arg(long)]
    pub session: Option<PathBuf>,
    #[arg(long)]
    pub fork: Option<PathBuf>,
    #[arg(long)]
    pub session_dir: Option<PathBuf>,
    #[arg(long)]
    pub no_session: bool,
    #[arg(short = 'n', long)]
    pub name: Option<String>,
    #[arg(short = 't', long, value_delimiter = ',')]
    pub tools: Vec<String>,
    #[arg(short = 'x', long = "exclude-tools", value_delimiter = ',')]
    pub exclude_tools: Vec<String>,
    #[arg(long = "no-builtin-tools")]
    pub no_builtin_tools: bool,
    #[arg(long)]
    pub no_tools: bool,
    #[arg(short = 'e', long = "extension")]
    pub extensions: Vec<PathBuf>,
    #[arg(long)]
    pub no_extensions: bool,
    #[arg(long)]
    pub skill: Vec<PathBuf>,
    #[arg(long)]
    pub no_skills: bool,
    #[arg(long = "prompt-template")]
    pub prompt_templates: Vec<PathBuf>,
    #[arg(long)]
    pub no_prompt_templates: bool,
    #[arg(long)]
    pub theme: Vec<PathBuf>,
    #[arg(long)]
    pub no_themes: bool,
    #[arg(long)]
    pub no_context_files: bool,
    #[arg(long)]
    pub system_prompt: Option<String>,
    #[arg(long)]
    pub append_system_prompt: Option<String>,
    #[arg(long)]
    pub tui_mode: Option<String>,
    #[arg(long = "use-theme")]
    pub use_theme: Option<String>,
    #[arg(short = 'a', long)]
    pub approve: bool,
    #[arg(long = "no-approve")]
    pub no_approve: bool,
    #[arg(long)]
    pub offline: bool,
    #[arg(long)]
    pub verbose: bool,
    #[arg(value_name = "MESSAGE", trailing_var_arg = true, allow_hyphen_values = true)]
    pub messages: Vec<String>,
}
impl Cli {
    #[must_use]
    pub fn effective_mode(&self) -> OutputMode {
        if self.print { OutputMode::Print } else { self.mode }
    }
}

#[derive(Subcommand, Debug)]
pub enum Command {
    Install {
        source: String,
        #[arg(short = 'l', long)]
        local: bool,
    },
    Remove {
        source: String,
        #[arg(short = 'l', long)]
        local: bool,
    },
    Uninstall {
        source: String,
        #[arg(short = 'l', long)]
        local: bool,
    },
    Update {
        source: Option<String>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        extensions: bool,
        #[arg(long)]
        models: bool,
        #[arg(long)]
        self_update: bool,
        #[arg(long)]
        force: bool,
    },
    List,
    Config,
    Login {
        provider: Option<String>,
        #[arg(long)]
        oauth: bool,
    },
    Logout {
        provider: Option<String>,
    },
    Export {
        input: PathBuf,
        output: Option<PathBuf>,
    },
}

#[must_use]
pub fn parse_thinking(value: &str) -> Option<pi_ai::ThinkingLevel> {
    match value.to_ascii_lowercase().as_str() {
        "off" => Some(pi_ai::ThinkingLevel::Off),
        "minimal" => Some(pi_ai::ThinkingLevel::Minimal),
        "low" => Some(pi_ai::ThinkingLevel::Low),
        "medium" => Some(pi_ai::ThinkingLevel::Medium),
        "high" => Some(pi_ai::ThinkingLevel::High),
        "xhigh" => Some(pi_ai::ThinkingLevel::Xhigh),
        "max" => Some(pi_ai::ThinkingLevel::Max),
        _ => None,
    }
}
