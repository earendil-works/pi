# Quickstart

This gets Pi installed and working on a real project.

## Install

Pi requires Node.js 22.19 or newer. Install it from npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi doesn't need dependency lifecycle scripts. On Linux and macOS, you can use the installer instead:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

## Run Pi

Go to the project you want to work on and start Pi:

```bash
cd /path/to/project
pi
```

The directory matters. Pi uses it to find project files and configuration, and to group saved sessions.

Run `/login`, choose a provider, and follow its authentication flow. If you prefer an API key, set it before starting Pi:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

See [Providers](providers.md) for other providers and authentication methods.

## Run a task

A useful first request is:

```text
Explain how this repository is structured and how to run its checks.
```

As the model works, Pi shows every tool call and result. The default tools let it read and change files and run shell commands. Everything becomes part of the session.

Pi doesn't ask before every tool call. Use version control and review what changed. For untrusted work, run Pi in a container or another sandbox. See [Security](security.md).

## Add project instructions

Most projects have commands and rules that the model can't infer reliably. Put them in an `AGENTS.md` file:

```markdown
# Project instructions

- Run `npm run check` after changing code.
- Do not run production migrations.
```

Pi reads global and project context files when it starts. If you change them during a session, run `/reload`.

## Continue later

Pi saves sessions automatically. To continue the most recent one, run:

```bash
pi --continue
```

Use `/resume` to choose another session. Use `/tree` to return to an earlier point without losing the work that followed it. The [Sessions](sessions.md) guide explains both.

Read [How Pi Works](how-pi-works.md) for a deeper explanation and [Using Pi](usage.md) for the interactive controls.

## Uninstall

If you installed Pi directly with npm, uninstall it with:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

If you used the shell installer, run it again and choose **Uninstall Pi**:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Neither method removes your configuration, credentials, sessions, or installed Pi packages from `~/.pi/agent/`.
