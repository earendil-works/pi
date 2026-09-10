# Pi

Pi is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use Pi for software development, research notes, writing projects, data files, or hobby work. You can use Pi as is, prompt it to adapt itself to your workflow, or build other applications powered by Pi using the SDK.

## Start using Pi

New to Pi? Follow the [Quickstart](quickstart.md) to install Pi, connect a model, and complete your first task.

If Pi is already installed, choose what you want to do:

- [Use Pi interactively](interactive-use.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models-and-providers.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions-and-context.md) to resume work or explore another approach without losing history.
- [Configure Pi](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how Pi works](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customise Pi

Pi can reuse prompts, load specialised instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customisation chooser](quickstart.md#choose-how-to-customise-pi) to select the smallest mechanism that meets your need.

## Automate or embed Pi

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate Pi process.
- Use the [TypeScript SDK](sdk.md) to run Pi inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings-reference.md), [provider authentication](provider-reference.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

Pi's tools and extensions run with the permissions of the Pi process. Project trust controls which project resources Pi loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
