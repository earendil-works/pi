{
  autoPatchelfHook,
  fd,
  importNpmLock,
  lib,
  makeWrapper,
  nodejs_22,
  ripgrep,
  source,
  stdenv,
}:

let
  nodejs = nodejs_22;
  packageJson = lib.importJSON (source + "/packages/coding-agent/package.json");
  runtimePackageJson = removeAttrs packageJson [ "devDependencies" ];
  packageLock = lib.importJSON (source + "/packages/coding-agent/npm-shrinkwrap.json");

  workspacePackages = stdenv.mkDerivation {
    pname = "pi-workspace-packages";
    inherit (packageJson) version;
    src = source;

    npmDeps = importNpmLock { npmRoot = source; };
    npmRebuildFlags = [ "--ignore-scripts" ];

    nativeBuildInputs = [
      nodejs
      importNpmLock.npmConfigHook
    ];

    buildPhase = ''
      runHook preBuild
      npm run build:offline
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      pack_package() {
        local package_dir="$1"
        local output_name="$2"
        local tarball

        tarball="$(cd "$package_dir" && npm pack --ignore-scripts --silent --pack-destination "$TMPDIR")"
        mv "$TMPDIR/$tarball" "$out/$output_name.tgz"
      }

      mkdir -p "$out"
      pack_package packages/chord chord
      pack_package packages/telemetry telemetry
      pack_package packages/ai ai
      pack_package packages/tui tui
      pack_package packages/agent agent
      pack_package packages/protocol protocol
      pack_package packages/client client
      pack_package packages/coding-agent coding-agent

      mkdir "$out/coding-agent"
      tar -xzf "$out/coding-agent.tgz" --strip-components=1 -C "$out/coding-agent"
      rm "$out/coding-agent.tgz"

      # The final derivation installs from a Nix-rewritten copy of this file.
      # Keeping the original beside it would make npm prefer the unrewritten
      # registry URLs.
      rm "$out/coding-agent/npm-shrinkwrap.json"

      runHook postInstall
    '';
  };

  npmDeps = importNpmLock {
    package = runtimePackageJson;
    inherit packageLock;
    packageSourceOverrides = {
      "node_modules/@earendil-works/chord" = workspacePackages + "/chord.tgz";
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      "node_modules/@earendil-works/pi-client" = workspacePackages + "/client.tgz";
      "node_modules/@earendil-works/pi-protocol" = workspacePackages + "/protocol.tgz";
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
stdenv.mkDerivation {
  pname = "pi";
  inherit (packageJson) version;
  src = workspacePackages + "/coding-agent";
  inherit npmDeps;

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = [ nodejs ] ++ lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -R . "$out/lib/pi"

    makeWrapper ${nodejs}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/dist/bundle/cli.js" \
      --prefix PATH : ${
        lib.makeBinPath [
          nodejs
          fd
          ripgrep
        ]
      }

    runHook postInstall
  '';

  postFixup = ''
    test "$("$out/bin/pi" --version)" = "${packageJson.version}"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/esbuild').transformSync('const value: number = 1', { loader: 'ts' })"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/@mariozechner/clipboard')"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/@silvia-odwyer/photon-node')"
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://pi.dev";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
