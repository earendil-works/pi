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

      perSystem =
        system:
        let
          pkgs = nixpkgsFor system;
          pi = (pkgs.extend piOverlay).pi;
          treefmtWrapper = import ./nix/treefmt.nix { inherit pkgs source; };
          devShell = import ./nix/devshell.nix {
            inherit pkgs treefmtWrapper;
            nodejs = pkgs.nodejs_22;
          };
        in
        {
          inherit
            pkgs
            pi
            devShell
            treefmtWrapper
            ;
        };
    in
    {
      packages = forAllSystems (system: {
        default = (perSystem system).pi;
        pi = (perSystem system).pi;
      });

      devShells = forAllSystems (system: {
        default = (perSystem system).devShell;
      });

      formatter = forAllSystems (system: (perSystem system).treefmtWrapper);

      apps = forAllSystems (system: rec {
        default = pi;
        pi = {
          type = "app";
          program = getExe (perSystem system).pi;
          meta.description = (perSystem system).pi.meta.description;
        };
      });

      overlays.default = piOverlay;
    };
}
