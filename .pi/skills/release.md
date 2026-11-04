---
name: release
description: Prepare, publish, verify, and recover pi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing pi

> **NLT-Pi notice:** this skill was inherited from upstream Pi and describes the upstream release process (npm publishing under `@earendil-works`, the `pi.dev` release marker, the Nix `stable` branch). The CI workflows that process depends on (`build-binaries.yml`, `nix.yml`) were removed from this repository at the owner's direction, so steps 4-6 below no longer exist and nothing publishes automatically. NLT-Pi has no approved release or publishing process yet. Do not run the release script, push tags, or publish packages without explicit approval from Joshua W. Dorsey, Sr.; escalate instead. Steps 1-3 are kept for reference only.

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   If the test suite already passed in `npm run release:local` and only fails from machine load, `PI_RELEASE_SKIP_TESTS=1` skips `./test.sh` in the release script; checks and the packed install check still run. Use it only with the user's approval.

   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or install lock diffs the release creates before push.

   The release script pins the newest published model catalog for Nix (`nix/model-catalog.json`) and builds the checkout with it as the Nix build does (it fails if that catalog predates main's model changes; publish one first), bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **(Removed) CI publish, Nix build, and recovery**: upstream's steps 4-6 relied on `.github/workflows/build-binaries.yml` (npm trusted publishing and the `pi.dev` announcement) and `.github/workflows/nix.yml` (Nix release build and `stable` branch). Both workflows were removed from NLT-Pi, so there is no CI publish, announcement, or Nix release to verify or recover. Any future release automation needs the owner's approval and a new process.
