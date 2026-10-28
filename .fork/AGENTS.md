# Working on the JangMan-J/pi fork

Read this before changing anything. Upstream's own rules in the repo root `AGENTS.md` still apply; this file adds the fork's branch discipline. `.fork/` exists only on `next` and `fork/tooling`; from another branch, read it with `git show next:.fork/AGENTS.md`. To set up a development checkout, run `.fork/install-tests.sh`.

## Layout

`main` mirrors `earendil-works/pi` and is never edited. Each fork change lives on exactly one owning branch. `next` is generated: the first branch in `.fork/branches` plus a `--no-ff` merge of each following branch, in file order. Nobody commits on `next`; `.fork/sync.sh` refuses to rebuild while such commits exist.

| Branch | Owns |
| --- | --- |
| `feat/native-anthropic` | `packages/ai/src/api/anthropic-oauth/`, `api/anthropic-tool-choice.ts`, the Anthropic transport changes in `api/anthropic-messages.ts`, `auth/oauth/anthropic.ts` and its callback cancellation handling in `auth/oauth/callback-server.ts`, Claude rules in `catalog/build.ts`, `catalog/families/anthropic.ts` and the Anthropic-related provider definitions, `test/anthropic-*.test.ts`, `test/oauth-callback-server.test.ts`, `packages/coding-agent/test/anthropic-oauth-prompt-drift.test.ts` |
| `feat/native-antigravity` | `packages/ai/src/api/antigravity/`, `antigravity-api.ts`, `antigravity-images.ts`, `providers/antigravity.ts`, `auth/oauth/antigravity.ts`, additions to `google-shared.ts`, `test/antigravity-*.test.ts` |
| `feat/native-meta` | `providers/meta.ts`, the Meta branches in `api/openai-responses.ts`, `catalog/providers/meta.ts`, `test/meta-oauth.test.ts` |
| `feat/native-openai` | `api/openai-codex-responses.ts`, `catalog/families/openai.ts`, the OpenAI/Codex rules in `catalog/providers/openai.ts`, `openai-codex.ts` and `azure.ts`, the OpenAI context and mid-convo tests, the `end_turn` continuation in `packages/agent/src/agent-loop.ts` |
| `fix/coding-agent` | `providers/generic-endpoint.ts`, `providers/openrouter*.ts`, `providers/README.md`, `packages/coding-agent/src/core/model-runtime.ts`, `model-config.ts`, the stationarity example, the `/codemode` command in `extensions/codemode/index.ts`, provider-audit coverage and its static OpenAI fallback corrections, their tests |
| `feat/native-providers` | providers no other branch owns, such as Kimi Coding and xAI: `packages/ai/scripts/native-providers.ts` (catalog corrections such as the `kimi-for-coding` name and the unlisted `xai/grok-4.7-build-fast`) and its hooks in `catalog/providers/kimi-coding.ts` and `xai.ts`, `mergeModels` in `packages/coding-agent/src/core/remote-catalog-provider.ts`, `test/native-providers-catalog.test.ts`, `test/remote-catalog-names.test.ts`. A provider that collects enough fork changes moves to its own branch |
| `fork/tooling` | this directory (`.fork/`: `branches`, `sync.sh`, `check.sh`, `pack-release.sh`, `install-next.sh`, `install-tests.sh`, these docs) and `.github/workflows/fork-sync.yml` |

`packages/ai/catalog/` is touched by several branches. Edit only your model family's or provider's rules, on that provider's branch. A change that spans two providers is two commits on two branches.

## Releases

`next` is the repository's default branch. The workflow `.github/workflows/fork-sync.yml` runs daily, on every push to `next`, and on demand. On the schedule and on demand it first runs the full `sync.sh` (fast-forward `main` from upstream, rebase every branch, rebuild `next`, focused checks, push). Then, if the `next` commit has no release yet, it builds, runs `npm run check` and `.fork/check.sh focused`, packs the build with `.fork/pack-release.sh` (the layout pi's own installer produces), and publishes the GitHub release `next-<first 12 hex of the commit>` with `pi-next.tar.gz` and its `.sha256`. It releases only when `sync.sh --status` is clean: no commits on `next` outside the listed branches, every branch on `main`, and `main` a mirror of upstream. This gate holds for every pusher, person or agent, on any machine. A failed check publishes nothing. The five newest releases are kept.

Machines that run pi install with `.fork/install-next.sh`: it downloads the latest release, verifies the SHA-256, unpacks it under `~/.local/share/pi-fork/releases/`, and switches `~/.local/bin/pi`. It builds and checks nothing; the workflow did. `--rollback` switches back to the previous release.

## Order of work

1. **Check state** on `next`: `git checkout next && .fork/sync.sh --status`. On a machine that has fallen behind (branches shown behind origin, `next` stale), run `.fork/sync.sh --align` first; it resets `main`, the branches and `next` to origin, but only where the local tip is already on an origin branch or tag, so nothing is lost. It tells you which branch you are on, whether each branch is rebased on `main`, and whether `next` is current, stale, or carries stray commits. Fix a dirty tree before anything else.
2. **Pick the owning branch** from the table and switch to it: `git checkout <branch>`. If you are on `next` or `main`, do not commit there.
3. **Bring the branch up to date**: `git fetch origin && git rebase origin/<branch>` (or `git reset --hard origin/<branch>` if you have no local commits on it).
4. **Make the change with its test.** Every wire change gets a payload-shape test in the branch's test file that pins the bytes. Where server behavior decides, run a live probe and record the sanitized result in the commit message. Run the tests you touched (`cd packages/<package> && npx vitest run test/<file>`); the focused checks run in step 6.
5. **Commit on the branch.** Commits are signed when the global git config sets `commit.gpgsign=true` and `user.signingkey` to a key GitHub knows (Jang's is `9B79F5EBD9E8D2E5`); `install-tests.sh` warns when signing is off. The pre-commit hook runs `npm run check`. `install-tests.sh` installs it with husky, because `npm ci --ignore-scripts` skips upstream's `prepare` step; if `git config core.hooksPath` prints nothing, run `npx husky` once. Use the upstream commit style, for example `fix(ai): …`.
6. **Rebuild `next`**: `git checkout next && .fork/sync.sh --rebuild-only`. It tags the old `next`, rebuilds it from the current tips, and runs the focused checks. Nothing is fetched or rebased.
7. **Push**: `.fork/sync.sh --rebuild-only --push`, or `git push --force-with-lease origin <branch> next`. `next` is always force-pushed because it is regenerated; the branches only when they were rebased. The push to `next` starts the workflow, which checks and publishes the release.

The workflow pulls in upstream daily. To do it by hand, run `.fork/sync.sh` (full mode) on `next` instead of step 6. Order inside it is fixed: tag tips, fetch, fast-forward `main`, rebase every branch onto `main` in file order, rebuild `next`, check, optionally push. If a rebase stops on a conflict, resolve it, `git rebase --continue`, return to `next`, and re-run `.fork/sync.sh --offline --resume`. Resume mode allows the old `next` commits that the rebase replaced; never use it to discard unrelated commits.

## Recovery

- Committed on `next` by mistake: `git checkout <owning branch> && git cherry-pick <sha>`, then `.fork/sync.sh --rebuild-only`.
- Need a previous state: every run leaves signed `pre-sync/<stamp>/<ref>` tags; the audit left `backup/*` tags. `git tag -l 'pre-sync/*'`.
- Branch not based on `main` after a manual change: `git rebase main <branch>`, then rebuild.

## Do not

- Commit on `main` or `next`.
- Edit `main`'s upstream files from a branch unless the change is the branch's purpose.
- Rewrite `next` by hand; always use `sync.sh`.
- Change `.fork/` or the workflow anywhere but `fork/tooling`.
- Skip the payload test or the probe; "it reads right" closes nothing.
