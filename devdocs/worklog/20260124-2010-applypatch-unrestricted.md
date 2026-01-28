## Worklog

### Slice 1 (in progress)
- Updated `packages/coding-agent/src/tools/apply-patch/engine.ts` to:
  - allow relative paths to resolve outside cwd
  - follow symlink parents and allow updating symlink files
  - remove O_NOFOLLOW usage
- Added vitest coverage in `packages/coding-agent/src/tools/apply-patch/path-access.test.ts`.
- Verified: `npm test -w @kennyfrc/pi-coding-agent -- src/tools/apply-patch/path-access.test.ts`

### Slice 2 (next)
- Updated `packages/coding-agent/src/prompts/tools.yaml` to reflect that ApplyPatch supports relative/absolute/~ paths.
- Verified:
  - `npm run check` (repo root)
  - `npm run build -w @kennyfrc/pi-coding-agent`

### Slice 3
- Regenerated matching-characterization golden master after trace output change:
  - `npx tsx packages/coding-agent/src/tools/apply-patch/generate-matching-golden-master.ts`
- Verified: `npm test -w @kennyfrc/pi-coding-agent`
