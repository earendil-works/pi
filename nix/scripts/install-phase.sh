set -eo pipefail

runHook preInstall

npm prune --omit=dev --workspaces --ignore-scripts --no-save

packageRoot="$out/lib/node_modules/@earendil-works/pi-coding-agent"
scopedModules="$packageRoot/node_modules/@earendil-works"
mkdir -p "$packageRoot" "$scopedModules" "$out/bin"

cp -R node_modules "$packageRoot/"
rm -rf "$scopedModules"
mkdir -p "$scopedModules"

copyWorkspacePackage() {
  local src="$1"
  local dest="$2"
  shift 2
  mkdir -p "$dest"
  for path in "$@"; do
    if [ -e "$src/$path" ]; then
      cp -R "$src/$path" "$dest/"
    fi
  done
}

copyWorkspacePackage packages/coding-agent "$packageRoot" \
  package.json README.md CHANGELOG.md npm-shrinkwrap.json dist docs examples
copyWorkspacePackage packages/agent "$scopedModules/pi-agent-core" \
  package.json README.md CHANGELOG.md dist
copyWorkspacePackage packages/ai "$scopedModules/pi-ai" \
  package.json README.md CHANGELOG.md bedrock-provider.d.ts bedrock-provider.js dist
copyWorkspacePackage packages/tui "$scopedModules/pi-tui" \
  package.json README.md CHANGELOG.md dist native

ln -s "$packageRoot" "$scopedModules/pi-coding-agent"
find "$packageRoot/node_modules" -xtype l -delete
chmod +x "$packageRoot/dist/cli.js"

makeBinaryWrapper "$PI_NIX_NODE" "$out/bin/pi" \
  --add-flags "$packageRoot/dist/cli.js" \
  --prefix PATH : "$PI_NIX_RUNTIME_PATH" \
  --set-default PI_PACKAGE_DIR "$packageRoot"

runHook postInstall
