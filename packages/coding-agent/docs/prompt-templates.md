# Prompt Templates

Prompt templates turn Markdown files into reusable `/` commands. Use one when you want to invoke the same prompt repeatedly without adding executable behavior or a larger set of supporting instructions.

A template can accept arguments, appear in command completion, and load from personal configuration, a trusted project, an explicit path, or a Pi package.

## Create a template

Create `~/.pi/agent/prompts/review.md`:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

The filename becomes the command name, so this template is available as `/review`. The `description` appears in command completion. If it is omitted, Pi uses the first non-empty line.

`argument-hint` is optional. Use `<angle brackets>` for required arguments and `[square brackets]` for optional arguments.

Run `/reload` after adding or changing a template in an active session.

## Invoke a template

Type the template command in the editor:

```text
/review
/review concurrency
```

Pi expands the template before the resulting text enters the agent. Extensions receive the raw input first through the `input` event unless an extension command with the same name handles it.

Templates support these substitutions:

| Syntax | Result |
|---|---|
| `$1`, `$2`, … | One positional argument |
| `$@` or `$ARGUMENTS` | All arguments joined with spaces |
| `${1:-default}` | First argument, or a default value |
| `${@:-default}` | All arguments, or a default value |
| `${@:N}` | Arguments starting at position `N` |
| `${@:N:L}` | `L` arguments starting at position `N` |

Arguments follow shell-like quoting, so `/review "API compatibility"` supplies one argument containing a space.

## Choose where it loads

Pi discovers templates from these sources:

| Source | Location or option |
|---|---|
| Personal | `~/.pi/agent/prompts/*.md` |
| Project | `.pi/prompts/*.md` after the project is trusted |
| Package | A `prompts/` directory or `pi.prompts` manifest entry |
| Settings | The `prompts` array |
| Command line | Repeatable `--prompt-template <path>` |

Conventional personal and project prompt directories load direct `.md` children only. To load nested templates, select their path through settings or package them.

Package and settings resource discovery can select nested Markdown files. A package manifest can narrow that discovery with explicit paths and globs.

Use `--no-prompt-templates` to disable normal template discovery for one run. Explicit `--prompt-template` paths still load.

Project templates become executable commands in the editor after trust is granted. Review their content before trusting an unfamiliar project. See [Security](security.md#project-trust).

## Choose a different mechanism

Use a [skill](skills.md) when the workflow needs detailed instructions, scripts, reference files, or assets that should load only when relevant.

Use an [extension](extensions.md) when the workflow needs executable logic, tools, events, state, or terminal UI. Use a [Pi package](packages.md) to install or distribute templates with other resources.
