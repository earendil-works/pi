#!/usr/bin/env bash
# Set up a development checkout of the fork (clone it if missing) and run the checks.
# It does not install `pi`; install-next.sh installs tested releases separately.
#
#   install-tests.sh            build the pi-env daemon, set up the .fork worktree and agent pointers, run the focused checks
#   install-tests.sh --all      same setup, then `npm run check` and the full `./test.sh` (several minutes)
#   install-tests.sh --no-run   setup only
#
# Options:
#   --dir DIR    checkout directory   PI_DIR    default ~/pi
#   --repo URL   fork to clone        PI_REPO   default https://github.com/JangMan-J/pi.git
#
# Needs cargo for packages/env (install with https://rustup.rs).
set -euo pipefail

dir="${PI_DIR:-$HOME/pi}"
repo="${PI_REPO:-https://github.com/JangMan-J/pi.git}"
mode="focused"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dir) dir="$2"; shift 2 ;;
		--repo) repo="$2"; shift 2 ;;
		--all) mode="all"; shift ;;
		--no-run) mode="none"; shift ;;
		-h|--help) sed -n '2,13p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'install-tests: %s\n' "$*" >&2; exit 1; }

if [[ ! -d "$dir/.git" ]]; then
	say "Cloning $repo (next) into $dir"
	git clone --branch next "$repo" "$dir"
fi
cd "$dir"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/earendil-works/pi.git

# Older checkouts mounted the fork-sync branch at .fork/ as a worktree; the tooling is now part of next.
# Each step below also resumes a conversion that stopped halfway.
if [[ -e .fork/.git ]]; then
	say "Removing the old fork-sync worktree at .fork"
	[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "$dir has uncommitted changes; commit or stash them first"
	git worktree remove --force .fork
fi
sed -i '/^\.fork$/d' .git/info/exclude 2>/dev/null || true
if [[ ! -x .fork/sync.sh ]]; then
	say "Moving next to origin/next, which carries .fork/"
	[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "$dir has uncommitted changes; commit or stash them first"
	git fetch -q --tags origin
	git checkout -q next 2>/dev/null || git checkout -q -b next origin/next
	# next is regenerated; reset it unless it holds a non-merge commit that origin lacks.
	[[ -z "$(git rev-list --no-merges next --not --remotes=origin --tags)" ]] ||
		die "local next has commits that are on no origin branch or tag; move them to their owning branch first"
	git reset -q --hard origin/next
fi
# The retired fork-sync branch is kept on origin as the tag archive/fork-sync.
if git rev-parse -q --verify refs/heads/fork-sync >/dev/null && git rev-parse -q --verify archive/fork-sync >/dev/null &&
	git merge-base --is-ancestor fork-sync archive/fork-sync; then
	git branch -q -D fork-sync
	echo "deleted the local fork-sync branch (kept as archive/fork-sync)"
fi
[[ -x .fork/sync.sh ]] || die "$dir has no .fork/ tooling; check out next"

if [[ ! -d node_modules ]]; then
	say "Installing dependencies (npm ci --ignore-scripts)"
	npm ci --ignore-scripts
fi
if [[ ! -f packages/coding-agent/dist/cli.js || ! -d packages/ai/dist ]]; then
	if ! npm --prefix packages/ai run check:model-data >/dev/null 2>&1; then
		say "Hydrating model data (npm run hydrate:model-data, needs network)"
		npm run hydrate:model-data
	fi
	say "Building packages (npm run build:offline)"
	npm run build:offline
fi

say "Building the pi-env daemon"
command -v cargo >/dev/null 2>&1 || die "cargo is required for packages/env tests; install it with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
(cd packages/env && npm run build:daemon)

chmod +x .fork/*.sh

say "Installing the pre-commit hook and checking commit signing"
# npm ci --ignore-scripts skips upstream's "prepare": "husky", which installs the hook that runs npm run check.
npx --no-install husky
[[ "$(git config --get commit.gpgsign)" == true ]] ||
	echo "warning: commit.gpgsign is not true, so fork commits will be unsigned (see .fork/AGENTS.md, step 5)"

say "Creating or aligning local main, feature branches and next from origin"
.fork/sync.sh --align

say "Pointing agents at .fork/AGENTS.md"
# Claude Code reads CLAUDE.local.md from the repo root; keep it out of git.
cat > CLAUDE.local.md <<'MD'
# Fork workflow
This checkout is the JangMan-J/pi fork. Before changing or committing anything, read `.fork/AGENTS.md`
(on `next`; from another branch, `git show next:.fork/AGENTS.md`) and run `.fork/sync.sh --status` on `next`.
Never commit on `main` or `next`.
MD
grep -qx 'CLAUDE.local.md' .git/info/exclude 2>/dev/null || echo 'CLAUDE.local.md' >> .git/info/exclude
# pi reads ~/.pi/agent/AGENTS.md in every directory; keep one guarded pointer block, replacing an older one.
pi_agents="${PI_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md"
if [[ -d "$(dirname "$pi_agents")" ]]; then
	[[ -f "$pi_agents" ]] && sed -i '/^<!-- fork-workflow:JangMan-J\/pi -->$/,/^<!-- \/fork-workflow -->$/d' "$pi_agents"
	cat >> "$pi_agents" <<'MD'
<!-- fork-workflow:JangMan-J/pi -->
## JangMan-J/pi fork checkouts
When the working directory is a checkout of JangMan-J/pi (`git remote get-url origin` names JangMan-J/pi), read
`.fork/AGENTS.md` before changing anything (on `next`; from another branch, `git show next:.fork/AGENTS.md`) and
run `.fork/sync.sh --status` on `next` first. Commit only on the owning branch, never on `main` or `next`.
<!-- /fork-workflow -->
MD
	echo "wrote the fork pointer block in $pi_agents"
fi

case "$mode" in
	focused) say "Running focused checks"; .fork/check.sh focused ;;
	all) say "Running npm run check and ./test.sh"; .fork/check.sh all ;;
	none) say "Setup complete; run .fork/check.sh focused or .fork/check.sh all" ;;
esac
