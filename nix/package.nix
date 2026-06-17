{ pkgs, srcRoot }:

let
  lib = pkgs.lib;
  nodejs = import ./nodejs.nix { inherit pkgs; };
  npmPackage =
    if builtins.elem "npm" (nodejs.outputs or [ ]) then
      lib.getOutput "npm" nodejs
    else
      nodejs;
  codingAgentPackage = builtins.fromJSON (builtins.readFile (srcRoot + "/packages/coding-agent/package.json"));
  packageSource = import ./package-source.nix { inherit lib srcRoot; };
  runtimePackages = [
    pkgs.fd
    pkgs.git
    pkgs.gnutar
    nodejs
    npmPackage
    pkgs.ripgrep
    pkgs.unzip
  ];
in
pkgs.buildNpmPackage {
  pname = "pi";
  version = codingAgentPackage.version;
  src = packageSource;

  npmDeps = pkgs.importNpmLock { npmRoot = packageSource; };
  npmConfigHook = pkgs.importNpmLock.npmConfigHook;
  npmFlags = [ "--ignore-scripts" ];
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [ pkgs.makeBinaryWrapper ];

  PI_NIX_ASSERT_RUNTIME_PATH = ./scripts/assert-runtime-path.cjs;
  PI_NIX_NODE = "${nodejs}/bin/node";
  PI_NIX_RUNTIME_PATH = lib.makeBinPath runtimePackages;

  buildPhase = "source ${./scripts/build-phase.sh}";
  installPhase = "source ${./scripts/install-phase.sh}";

  doInstallCheck = true;
  installCheckPhase = "source ${./scripts/install-check-phase.sh}";

  passthru = {
    inherit nodejs runtimePackages;
  };

  meta = {
    description = "Minimal terminal coding harness";
    homepage = "https://github.com/earendil-works/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
  };
}
