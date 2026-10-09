{
  perSystem =
    {
      nodejs,
      packageJson,
      pkgs,
      source,
      ...
    }:
    {
      checks = {
        repo-check = pkgs.stdenv.mkDerivation {
          pname = "pi-repo-check";
          inherit (packageJson) version;
          src = source;

          npmDeps = pkgs.importNpmLock { npmRoot = source; };
          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = with pkgs; [
            nodejs
            importNpmLock.npmConfigHook
          ];

          buildPhase = ''
            runHook preBuild
            npm run check:pinned-deps
            npm run check:runtime-deps
            npm run check:ts-imports
            npm run check:entry-graphs
            npm run check:install-lock:coding-agent

            # The remaining two steps of `npm run check`, kept here for
            # reference. `modelCatalog` is the pinned pi.dev revision from
            # `nix/model-catalog.json`, fetched the way `nix/package.nix`
            # fetches it.
            # node packages/ai/scripts/hydrate-model-catalog.ts ''${modelCatalog}
            # npx tsc --noEmit

            npm run check:browser-smoke
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            touch $out
            runHook postInstall
          '';
        };

        test-scripts = pkgs.stdenv.mkDerivation {
          pname = "pi-test-scripts";
          inherit (packageJson) version;
          src = source;

          npmDeps = pkgs.importNpmLock { npmRoot = source; };
          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = with pkgs; [
            nodejs
            git
            importNpmLock.npmConfigHook
          ];

          buildPhase = ''
            runHook preBuild
            npm run test:scripts
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            touch $out
            runHook postInstall
          '';
        };
      };
    };
}
