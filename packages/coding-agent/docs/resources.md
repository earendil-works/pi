# Skills, prompts, themes, and packages

Skills follow the Agent Skills `SKILL.md` format and are discovered globally and in trusted projects. `/skill:name` loads one skill with optional arguments.

Prompt templates are Markdown files with YAML frontmatter and support `$1`, `$@`, `$ARGUMENTS`, and default substitutions. Themes are JSON color resources. Pi packages may declare resource paths under a `pi` object in `package.json`; package data is parsed by Rust and no package scripts are executed.

`pi install` supports local, git, and npm registry sources. npm tarballs are downloaded and safely unpacked directly by Rust.
