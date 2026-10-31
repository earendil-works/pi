{
  autoPatchelfHook,
  fd,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  makeBinaryWrapper,
  ripgrep,
  nodejs,
  packageJson,
  platforms,
  source,
  stdenv,
  wl-clipboard,
  xclip,
}:

let
  inherit (lib)
    importJSON
    removePrefix
    optionals
    getExe
    makeBinPath
    licenses
    sourceTypes
    ;
  # Lockfile root used by the pi.dev installer. It pins the coding agent's
  # runtime dependency tree and is kept in sync with package-lock.json by
  # `npm run check`.
  installLock = source + "/packages/coding-agent/install-lock";
  modelCatalogPin = importJSON ./model-catalog.json;
  modelCatalog = fetchurl {
    name = "pi-model-catalog.json";
    # The typed catalog is the representation whose bytes the revision hashes.
    url = "https://pi.dev/api/models/revisions/${modelCatalogPin.revision}?types=chat,image,classifier";
    sha256 = removePrefix "sha256-" modelCatalogPin.revision;
  };

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
      node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}
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
      pack_package packages/telemetry telemetry
      pack_package packages/ai ai
      pack_package packages/tui tui
      pack_package packages/agent agent
      pack_package packages/codemode codemode
      pack_package packages/mcp mcp
      pack_package packages/coding-agent coding-agent

      runHook postInstall
    '';
  };

  npmDeps = importNpmLock {
    npmRoot = installLock;
    # The install lock points internal packages at registry releases. Replace
    # them with the packages built from this checkout.
    packageSourceOverrides = {
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      "node_modules/@earendil-works/pi-codemode" = workspacePackages + "/codemode.tgz";
      "node_modules/@earendil-works/pi-coding-agent" = workspacePackages + "/coding-agent.tgz";
      "node_modules/@earendil-works/pi-mcp" = workspacePackages + "/mcp.tgz";
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "pi";
  inherit (packageJson) version;
  src = installLock;
  inherit npmDeps;

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeBinaryWrapper
  ]
  ++ optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = optionals stdenv.hostPlatform.isLinux [ libxcb ];

  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -R . "$out/lib/pi"

    # The wrapper runs Pi with an absolute Node path. Node is only on PATH so Pi can
    # find npm for package installs; append it so that shells started by the
    # bash tool keep the user's node/npm (e.g. from mise or nvm). fd, ripgrep,
    # and the clipboard tools are Pi's own dependencies and take precedence.
    makeBinaryWrapper ${lib.getExe nodejs} "$out/bin/pi" \
      --add-flags "$out/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
      --suffix PATH : ${lib.makeBinPath [ nodejs ]} \
      --prefix PATH : ${
        makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      } \
      --set-default PI_SKIP_VERSION_CHECK 1

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$("$out/bin/pi" --version)" = "${packageJson.version}"
    # Load host-platform TUI helpers directly so missing native dependencies
    # fail the build rather than silently disabling clipboard support.
    ${getExe nodejs} -e \
      "const fs = require('node:fs');
       const path = require('node:path');
       const dir = '$out/lib/pi/node_modules/@earendil-works/pi-tui/native/' + process.platform + '/prebuilds/' + process.platform + '-' + process.arch;
       if (fs.existsSync(dir)) {
         for (const file of fs.readdirSync(dir)) {
           if (file.endsWith('.node')) require(path.join(dir, file));
         }
       }"
    ${getExe nodejs} -e \
      "require('$out/lib/pi/node_modules/@silvia-odwyer/photon-node')"
    runHook postInstallCheck
  '';

  meta = {
    inherit (packageJson) description;
    homepage = "https://pi.dev";
    license = licenses.mit;
    mainProgram = finalAttrs.pname;
    inherit platforms;
    sourceProvenance = with sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
})
