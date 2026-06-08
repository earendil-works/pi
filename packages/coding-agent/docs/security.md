# Security

Pi is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether pi loads project-local inputs. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Pi considers a project to have trust inputs when it finds any of these from the current working directory:

- `.pi/` in the current directory
- `AGENTS.md` or `CLAUDE.md` in the current directory or an ancestor directory
- `.agents/skills` in the current directory or an ancestor directory

When an interactive session starts in a project with trust inputs and no saved decision, pi asks whether to trust the project. Saved decisions are stored per canonical working directory in `~/.pi/agent/trust.json`.

Trusting a project allows pi to load project-local inputs, including:

- project instructions from `AGENTS.md` or `CLAUDE.md`
- `.pi/settings.json`
- `.pi` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips those project-local inputs. Before trust is resolved, pi only loads user/global extensions and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without a saved trust decision, they ignore project-local inputs unless `--approve`/`-a` is passed. Use `--no-approve`/`-na` to ignore project-local inputs for one run even when the project is trusted.

Setting `alwaysTrust` to `true` in global settings disables all trust gating — every project is treated as trusted without prompting. This is equivalent to permanently passing `--approve`.

## No Built-in Sandbox

Pi does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Pi is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing pi's instructions, settings, or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, or build output is expected local-agent risk and cannot be reliably prevented by pi.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run pi in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `pi` process inside OpenShell or Docker
- run host pi while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.pi/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](https://github.com/earendil-works/pi-mono/blob/main/SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how pi grants access that the local user did not already have.
