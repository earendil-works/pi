# scripts

## Purpose
Monorepo-level build, release, and utility scripts for version management, releasing to npm, cost analysis, and session transcript extraction.

## Technology
TypeScript (tsx) and JavaScript (mjs) scripts. Node.js >= 20.

## Contents
- `release.mjs` - Automated release script: checks for uncommitted changes, bumps version, updates CHANGELOGs (`[Unreleased]` -> `[version] - date`), commits, tags, publishes to npm, adds new `[Unreleased]` sections
- `sync-versions.js` - Enforces lockstep versioning: reads all `packages/*/package.json`, verifies identical versions, updates inter-package `@mariozechner/*` dependency versions to `^<current>`
- `build-binaries.sh` - Builds compiled Bun binary distributions
- `cost.ts` - Cost analysis script for LLM token usage
- `session-transcripts.ts` - Extracts session transcripts for analysis
- `browser-smoke-entry.ts` - Browser smoke test entry point: verifies pi-ai imports resolve correctly
- `check-browser-smoke.mjs` - Runs esbuild browser bundle check for smoke testing
- `oss-weekend.mjs` - Manages OSS weekend state (activate/deactivate `.github/oss-weekend.json`)

## Key Functions
- `release.mjs`: `run(cmd, options?)`, `getVersion()`, `getChangelogs()`, `updateChangelogsForRelease(version)`
- `sync-versions.js`: reads all package.json files, builds version map, validates lockstep, updates cross-dependencies

## Data Types
N/A - scripts operate on filesystem and package.json structures.

## Logging
Console output via `console.log` and `console.error`.

## CRUD Entry Points
- **Create**: Add new script files for build/release automation
- **Read**: Scripts are invoked via `npm run` commands defined in root `package.json`
- **Update**: Edit scripts to modify release/build workflows
- **Delete**: Remove script and corresponding `package.json` script entry

## Style Guide
- `.mjs` extension for ESM JavaScript scripts
- `.ts` extension for TypeScript scripts (run via `tsx`)
- `execSync` for shell commands with inherited stdio
- Tab indentation, consistent with monorepo biome config

```javascript
function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}
```
