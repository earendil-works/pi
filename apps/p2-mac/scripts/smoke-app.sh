#!/usr/bin/env bash
# Checks that a packaged Pi.app's own p2 starts: its signed Node runs the server from the app's resources, with a
# throwaway data directory and the faux provider, and the server answers /health.
#
#   ./scripts/smoke-app.sh build/Pi.app
set -euo pipefail
app="${1:?usage: smoke-app.sh <Pi.app>}"
resources="$(cd "$app/Contents/Resources" && pwd)"
data="$(mktemp -d)"
port=18797
log="$data.log"
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$data" "$log"' EXIT

# A bare environment: the server must not depend on a Node or tools on the builder's PATH.
(cd "$resources/p2/apps/p2" && exec env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin PORT=$port \
	P2_DATA_DIR="$data" P2_FAKE=1 "$resources/node/bin/node" --import ./src/source.ts src/hosts/server.ts) >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 120); do
	if curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"name":"p2"'; then
		echo "smoke test: p2 answers on port $port"
		exit 0
	fi
	if ! kill -0 "$pid" 2>/dev/null; then break; fi
	sleep 1
done
echo "smoke test failed; server output:" >&2
cat "$log" >&2
exit 1
