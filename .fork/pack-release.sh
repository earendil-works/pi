#!/usr/bin/env bash
# Pack a built checkout into the release that install-next.sh installs.
#
#   .fork/pack-release.sh OUT_DIR
#
# Run after `npm run build:offline` with model data. Packs the pi packages that
# packages/coding-agent/install-lock lists, points their lockfile entries at those tarballs, and
# installs the lockfile with `npm ci --omit=dev`: the layout pi's own installer produces, with every
# other dependency at its pinned version. Writes OUT_DIR/pi-next.tar.gz, its .sha256, and
# OUT_DIR/release.json; the tarball holds release.json, package.json and node_modules/.
set -euo pipefail

out="${1:?usage: pack-release.sh OUT_DIR}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && git rev-parse --show-toplevel)"
cd "$repo"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/tarballs" "$work/install"
cp packages/coding-agent/install-lock/package.json "$work/install/package.json"

# Pack each internal package and point its lockfile entry at the tarball. Nothing internal may come
# from the npm registry: upstream's published code would replace the fork's, and an unpublished
# version would fail the install.
node - "$work" <<'NODE'
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const work = process.argv[2];
const lockPath = "packages/coding-agent/install-lock/package-lock.json";
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const workspaces = new Map();
for (const dir of readdirSync("packages")) {
	try {
		workspaces.set(JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8")).name, `packages/${dir}`);
	} catch {}
}
const internal = Object.keys(lock.packages).filter((key) => /^node_modules\/@earendil-works\/[^/]+$/.test(key));
if (internal.length === 0) throw new Error(`${lockPath} lists no @earendil-works packages`);
for (const key of internal) {
	const name = key.slice("node_modules/".length);
	const workspace = workspaces.get(name);
	if (!workspace) throw new Error(`${name} is in ${lockPath} but is no workspace package`);
	const result = JSON.parse(
		execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", `${work}/tarballs`, "--workspace", workspace], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}),
	);
	const info = Array.isArray(result) ? result[0] : Object.values(result)[0];
	const entry = lock.packages[key];
	if (entry.version !== info.version) throw new Error(`${name}: lockfile has ${entry.version}, workspace has ${info.version}`);
	entry.resolved = `file:../tarballs/${info.filename}`;
	entry.integrity = info.integrity;
	console.log(`packed ${name}@${info.version}`);
}
writeFileSync(`${work}/install/package-lock.json`, `${JSON.stringify(lock, null, "\t")}\n`);
NODE

(cd "$work/install" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

node - "$work/install" <<'NODE'
const { readFileSync } = require("node:fs");
const installed = JSON.parse(readFileSync(`${process.argv[2]}/node_modules/.package-lock.json`, "utf8")).packages;
const foreign = Object.entries(installed).filter(
	([key, entry]) => /^node_modules\/@earendil-works\/[^/]+$/.test(key) && !String(entry.resolved).startsWith("file:"),
);
if (foreign.length > 0) throw new Error(`installed from the registry instead of this build: ${foreign.map(([key]) => key).join(", ")}`);
NODE

cli="$work/install/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
version="$(node "$cli" --version)"
commit="$(git rev-parse HEAD)"
printf '{\n\t"commit": "%s",\n\t"version": "%s",\n\t"builtAt": "%s"\n}\n' \
	"$commit" "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$work/install/release.json"
cp "$work/install/release.json" "$out/release.json"
tar -C "$work/install" -czf "$out/pi-next.tar.gz" .
(cd "$out" && sha256sum pi-next.tar.gz > pi-next.tar.gz.sha256)
echo "packed pi $version at ${commit:0:9}: $out/pi-next.tar.gz ($(du -h "$out/pi-next.tar.gz" | cut -f1))"
