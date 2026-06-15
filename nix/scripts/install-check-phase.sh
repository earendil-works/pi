set -eo pipefail

runHook preInstallCheck

export HOME="$TMPDIR/home"
mkdir -p "$HOME"

NODE_OPTIONS="--require $PI_NIX_ASSERT_RUNTIME_PATH" "$out/bin/pi" --version
"$out/bin/pi" --version
"$out/bin/pi" --help > /dev/null
PI_OFFLINE=1 "$out/bin/pi" --list-models > /dev/null

runHook postInstallCheck
