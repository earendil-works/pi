#!/usr/bin/env bash
# Checks for the fork's integration branch.
#
#   .fork/check.sh focused   sync regression and provider payload tests touched by the fork (fast, no network)
#   .fork/check.sh all       npm run check (biome, tsc, pinned deps) and the full ./test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
cd "$repo"

# The standalone-process tests spawn plain node on source files, which resolve workspace packages
# through their package.json exports (dist/). Build any such dependency of pi-ai that is not built yet.
ensure_ai_deps_built() {
	local pkg dir
	for pkg in $(node -e 'const d=require("./packages/ai/package.json");console.log(Object.keys({...d.dependencies,...d.peerDependencies}).filter(k=>k.startsWith("@earendil-works/")).join(" "))'); do
		dir="$(readlink -f "node_modules/$pkg")"
		[[ -d "$dir" && ! -d "$dir/dist" ]] || continue
		echo "building $pkg (dist missing)"
		(cd "$dir" && npm run build >/dev/null)
	done
	if [[ ! -d "packages/ai/dist" ]]; then
		echo "building @earendil-works/pi-ai (dist missing)"
		(
			cd packages/ai
			npm run check:model-data >/dev/null 2>&1 || npm run hydrate-model-data >/dev/null
			npm run build:offline >/dev/null
		)
	fi
}

case "${1:-focused}" in
	focused)
		"$here/test-sync.sh"
		ai_tests=(
			antigravity-native antigravity-images antigravity-catalog antigravity-oauth
			anthropic-oauth-payload anthropic-model-generation anthropic-oauth-security anthropic-oauth-system-prompt
			anthropic-force-adaptive-thinking anthropic-temperature-compat anthropic-mid-conversation-effort
			anthropic-thinking-disable anthropic-oauth oauth-callback-server anthropic-sse-parsing
			google-shared-gemini3-unsigned-tool-call google-shared-convert-tools
			google-thinking-level-map google-raw-stop-reason google-stop-reason-continuation meta-oauth
			generic-endpoint-provider
			openai-responses-mid-convo-effort openai-codex-stream openai-responses-compat
			openai-completions-tool-choice images-models
			native-providers-catalog native-providers-kimi-wire
			virtual-models-runtime
		)
		core_agent_tests=(agent-loop agent-request-update)
		durable_tests=(virtual-models-durable)
		agent_tests=(
			add-endpoint-provider remote-catalog-names anthropic-oauth-prompt-drift references
			virtual-models interactive-mode-suppressed-messages
			suite/virtual-models suite/virtual-model-substrate suite/suppress-text-display
		)
		# vitest skips a listed file that does not exist, so a branch missing from next would pass silently.
		missing=()
		for t in "${ai_tests[@]}"; do [[ -f "packages/ai/test/$t.test.ts" ]] || missing+=("packages/ai/test/$t.test.ts"); done
		for t in "${core_agent_tests[@]}"; do [[ -f "packages/agent/test/$t.test.ts" ]] || missing+=("packages/agent/test/$t.test.ts"); done
		for t in "${durable_tests[@]}"; do [[ -f "packages/durable/test/$t.test.ts" ]] || missing+=("packages/durable/test/$t.test.ts"); done
		for t in "${agent_tests[@]}"; do [[ -f "packages/coding-agent/test/$t.test.ts" ]] || missing+=("packages/coding-agent/test/$t.test.ts"); done
		if [[ ${#missing[@]} -gt 0 ]]; then
			printf 'focused test file missing (is its branch merged into this checkout?): %s\n' "${missing[@]}" >&2
			exit 1
		fi
		ensure_ai_deps_built
		(cd packages/ai && npx vitest run "${ai_tests[@]/#/test/}")
		(cd packages/agent && npx vitest run "${core_agent_tests[@]/#/test/}")
		(cd packages/durable && npx vitest run "${durable_tests[@]/#/test/}")
		(cd packages/coding-agent && npx vitest run "${agent_tests[@]/#/test/}")
		;;
	all)
		npm run check
		./test.sh
		;;
	*)
		echo "usage: $0 [focused|all]" >&2
		exit 2
		;;
esac
