{
  description = "Pi coding agent";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ flake-parts, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
    in
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.flake-parts.flakeModules.easyOverlay
        ./nix/treefmt.nix
        ./nix/checks.nix
        ./nix/devshell.nix
      ];

      inherit systems;

      perSystem =
        {
          config,
          inputs',
          lib,
          self',
          system,
          ...
        }:
        let
          pkgs =
            (if system == "x86_64-darwin" then inputs'.nixpkgs-darwin-x64 else inputs'.nixpkgs).legacyPackages;

          source = inputs.self;

          nodejs = pkgs.nodejs_22;

          packageJson = lib.importJSON "${source}/packages/coding-agent/package.json";

          pi = pkgs.callPackage ./nix/package.nix {
            inherit
              source
              nodejs
              packageJson
              ;
            platforms = systems;
          };
        in
        {
          _module.args = {
            inherit
              pkgs
              source
              nodejs
              packageJson
              ;
          };

          overlayAttrs.pi = pi;

          packages = {
            default = pi;
            inherit pi;
          };

          apps = {
            default = {
              type = "app";
              program = "${lib.getExe self'.packages.default}";
              meta.description = pi.meta.description;
            };
            pi = config.apps.default;
          };
        };
    };
}
