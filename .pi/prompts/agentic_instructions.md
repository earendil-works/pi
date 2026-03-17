# .pi/prompts

## Purpose
Prompt templates for the pi coding agent. These are reusable prompts invoked via slash commands (e.g., `/cl`, `/pr`, `/is`) that inject structured instructions into the agent context.

## Technology
Markdown files with YAML frontmatter. Support `$ARGUMENTS` and `$@` template variables for parameter injection.

## Contents
- `cl.md` - `/cl` changelog audit prompt: finds last release tag, lists commits, cross-checks changelog entries across packages, proposes new features section
- `pr.md` - `/pr` PR review prompt: reads PR page, linked issues, analyzes diff against main, checks changelog, provides Good/Bad/Ugly structured review
- `is.md` - `/is` issue analysis prompt: reads issue and comments, traces code paths, proposes fixes for bugs or implementation plans for features

## Key Functions
N/A - declarative prompt templates, not executable code.

## Data Types
- YAML frontmatter: `{ description: string }` - short description shown in command list

## Logging
N/A

## CRUD Entry Points
- **Create**: Add a new `.md` file with frontmatter to register a new prompt template as a slash command
- **Read**: Templates are loaded by the resource loader from this directory and the agent's prompts directory
- **Update**: Edit markdown content to change prompt behavior
- **Delete**: Remove a `.md` file to unregister the prompt template

## Style Guide
- Frontmatter uses `description` field only
- Numbered steps for multi-step workflows
- `$ARGUMENTS` or `$@` for positional parameters
- Markdown code blocks for example commands
- Explicit "Do NOT implement unless asked" guardrails in analysis prompts
