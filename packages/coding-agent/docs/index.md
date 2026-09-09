# Pi

Pi is an extensible coding agent for the terminal that can also be embedded in applications through its TypeScript SDK.

You give it a task, the model decides what to do, and Pi provides the tools, project context, and session history it needs to do the work.

The core is deliberately small. Instead of prescribing one workflow, Pi lets you add tools, commands, providers, event handlers, and terminal UI with extensions. Skills and prompt templates handle reusable instructions.

## Start

If you are new to Pi, follow the [Quickstart](quickstart.md). It takes you from installation to a first task.

[How Pi Works](how-pi-works.md) explains what happens after you submit a prompt, how context is assembled, and why sessions are trees rather than flat transcripts.

## Use, extend, or embed Pi

For everyday work, start with [Using Pi](usage.md). The [sessions](sessions.md), [providers](providers.md), and [settings](settings.md) guides cover the parts you are most likely to configure.

If Pi doesn't work the way you want, change it. [Extensions](extensions.md), [skills](skills.md), and [Pi packages](packages.md) are the main ways to adapt it without modifying the core.

Use [RPC](rpc.md) to control a Pi process or [JSON mode](json.md) to consume structured events from a single run. To build applications powered by Pi use the [SDK](sdk.md).

## Security

Pi's tools run with the same permissions as Pi itself. Project trust controls which project resources are loaded, but it doesn't sandbox tool calls. Read [Security](security.md) before working with untrusted code.
