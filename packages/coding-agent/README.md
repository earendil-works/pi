<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible AI agent for the terminal. Adapt Pi to your workflow, not the other way around.

Ask Pi to create the prompt templates, skills, extensions, and themes you need, or install a Pi package. Use Pi directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

## Getting started

Install the command-line interface with npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

This requires Node.js 22.19 or newer. Pi does not require dependency lifecycle scripts for a normal npm installation.

On macOS or Linux, you can instead use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
