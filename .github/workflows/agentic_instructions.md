# .github/workflows

## Purpose
GitHub Actions CI/CD workflows for building, testing, linting, contributor approval, and binary releases.

## Technology
GitHub Actions YAML workflow definitions. Runs on `ubuntu-latest` with Node.js 22.

## Contents
- `ci.yml` - Main CI pipeline: checkout, install, build, check (biome + tsgo), test. Triggered on push/PR to main
- `build-binaries.yml` - Binary build pipeline for release artifacts
- `pr-gate.yml` - PR gating checks (contributor approval, label verification)
- `approve-contributor.yml` - Automated contributor approval workflow
- `oss-weekend-issues.yml` - Auto-closes issues from non-collaborators during active OSS weekends (reads `.github/oss-weekend.json` for state)

## Key Functions
N/A - declarative workflow definitions.

## Data Types
N/A

## Logging
GitHub Actions step output logging.

## CRUD Entry Points
- **Create**: Add a new `.yml` file to define a new workflow
- **Read**: GitHub reads workflows automatically on trigger events
- **Update**: Edit workflow files to modify CI steps
- **Delete**: Remove a `.yml` file to disable a workflow

## Style Guide
- Workflow names use PascalCase or title case
- Jobs use kebab-case identifiers
- Concurrency groups prevent duplicate runs on same ref
- System dependencies installed via `apt-get` (libcairo2, pango, fd-find, ripgrep)
