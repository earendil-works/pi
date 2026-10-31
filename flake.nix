{
  description = "A lightweight coding agent with minimal configuration, multi-provider LLM support, and an extensible architecture.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-x64,
    }:
    let
      inherit (nixpkgs) lib;
      inherit (lib) importJSON genAttrs getExe;

      source = self;
      packageJson = importJSON "${source}/packages/coding-agent/package.json";

      platforms = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      nixpkgsFor =
        system:
        (if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs).legacyPackages.${system};

      forAllSystems = genAttrs platforms;

      piOverlay = _final: prev: {
        pi = prev.callPackage ./nix/package.nix {
          inherit source packageJson platforms;
          nodejs = prev.nodejs_22;
        };
      };

      perSystem = forAllSystems (
        system:
        let
          pkgs = (nixpkgsFor system).extend piOverlay;
        in
        {
          inherit pkgs;
          inherit (pkgs) pi;
          nodejs = pkgs.nodejs_22;
        }
      );
    in
    {
      checks = forAllSystems (
        system:
        import ./nix/checks.nix {
          inherit (perSystem.${system}) pkgs pi nodejs;
          inherit source;
        }
      );

      packages = forAllSystems (system: {
        default = perSystem.${system}.pi;
        pi = perSystem.${system}.pi;
      });

      apps = forAllSystems (system: rec {
        default = pi;
        pi = {
          type = "app";
          program = getExe perSystem.${system}.pi;
          meta.description = perSystem.${system}.pi.meta.description;
        };
      });

      overlays.default = piOverlay;
    };
}
