#!/usr/bin/env bash
# Checks for the fork's integration branch.
#
#   .fork/check.sh focused   provider payload tests touched by the fork (fast, no network)
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
}

case "${1:-focused}" in
	focused)
		ensure_ai_deps_built
		(
			cd packages/ai
			npx vitest run \
				test/antigravity-native.test.ts \
				test/antigravity-images.test.ts \
				test/antigravity-catalog.test.ts \
				test/antigravity-oauth.test.ts \
				test/anthropic-oauth-payload.test.ts \
				test/anthropic-model-generation.test.ts \
				test/anthropic-oauth-security.test.ts \
				test/anthropic-oauth-system-prompt.test.ts \
				test/anthropic-force-adaptive-thinking.test.ts \
				test/anthropic-temperature-compat.test.ts \
				test/anthropic-mid-conversation-effort.test.ts \
				test/anthropic-thinking-disable.test.ts \
				test/anthropic-oauth.test.ts \
				test/oauth-callback-server.test.ts \
				test/google-shared-gemini3-unsigned-tool-call.test.ts \
				test/google-shared-convert-tools.test.ts \
				test/meta-oauth.test.ts \
				test/generic-endpoint-provider.test.ts \
				test/openrouter-regional.test.ts \
				test/openrouter-user-models.test.ts \
				test/openai-responses-mid-convo-effort.test.ts \
				test/openai-codex-stream.test.ts \
				test/provider-audit-model-generation.test.ts \
				test/native-providers-catalog.test.ts
		)
		(
			cd packages/coding-agent
			npx vitest run test/suite/stationarity-extension.test.ts test/remote-catalog-names.test.ts test/anthropic-oauth-prompt-drift.test.ts
		)
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
