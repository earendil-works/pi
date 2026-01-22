# Version Bumping

This monorepo uses lockstep versioning - all packages and the root `package.json` must have the same version.

## Bumping Versions

To bump versions, use one of these npm scripts:

- `npm run version:patch` - Bump patch version (e.g., 0.19.4 → 0.19.5)
- `npm run version:minor` - Bump minor version (e.g., 0.19.4 → 0.20.0)
- `npm run version:major` - Bump major version (e.g., 0.19.4 → 1.0.0)

**These scripts will:**
1. Update all `packages/*/package.json` versions
2. Update inter-package dependencies (e.g., `@kennyfrc/pi-ai` → `^0.19.5`)
3. Update root `package.json` version to match

## After Bumping

Always build and commit after bumping:

```bash
npm run build
git add -A
git commit -m "chore: bump version to X.Y.Z"
npm link  # If you want to test locally
```

**Note:** `npm run build` may update tracked generated files (e.g. `packages/ai/src/models.generated.*` and related compiled `.js/.d.ts`). Don’t revert them; commit them (ideally in their own commit if you want cleaner history).

## Notes

- Never manually edit version numbers in package.json files - use the scripts above
- Default to `npm run version:patch` without asking unless the user explicitly requests minor/major
- The `scripts/sync-versions.js` script ensures root and packages stay in sync
- This is a fork of upstream, so we maintain our own versioning

## Generated Files & Build Artifacts

- Some files are generated and may change as a side-effect of running scripts/builds (for example `packages/ai/src/models.generated.*`).
- When these generated files change alongside a feature/fix, keep commits atomic:
	- Commit the human-authored change(s) separately.
	- Commit generated/build-artifact updates separately (even if they were triggered indirectly).
- If it’s obviously a generated/build byproduct and the user has asked to proceed, do not repeatedly ask whether to include it; just keep it in a separate commit.

---

## General Guidelines

- When receiving the first user message, you MUST read README.md in full. Then proactively read the available package README.md files in full, in parallel:
    - packages/ai/README.md
    - packages/tui/README.md
    - packages/coding-agent/README.md
    - packages/pods/README.md
    - packages/proxy/README.md
- We must NEVER have type `any` anywhere, unless absolutely, positively necessary.
- If you are working with an external API, check node_modules for the type definitions as needed instead of assuming things.
- Always run `npm run check` in the project's root directory after making code changes.
- You must NEVER run `npm run dev` yourself. Doing is means you failed the user hard.
- Do NOT commit unless asked to by the user
- Keep you answers short and concise and to the point.
- Do NOT use inline imports ala `await import("./theme/theme.js");`
- Read `~/agent-tools/browser-tools/README.md` if you need to run an interact with a browser
- Use GitHub CLI to interact with GitHub issues and pull requests
