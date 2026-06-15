{
  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    devenv.url = "github:cachix/devenv";
    devenv.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = { self, nixpkgs, devenv, systems, ... } @ inputs:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forEachSystem
        (system:
          let
            pkgs = pkgsFor system;
            pi = import ./nix/package.nix {
              inherit pkgs;
              srcRoot = ./.;
            };
          in
          {
            default = pi;
            pi = pi;
          });

      apps = forEachSystem
        (system:
          import ./nix/apps.nix {
            pi = self.packages.${system}.pi;
          });

      devShells = forEachSystem
        (system:
          let
            pkgs = pkgsFor system;
          in
          {
            default = import ./nix/devshell.nix {
              inherit devenv inputs pkgs self;
            };
          });

      formatter = forEachSystem (system: (pkgsFor system).nixpkgs-fmt);
    };
}
