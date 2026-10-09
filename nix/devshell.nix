_: {
  perSystem =
    {
      config,
      nodejs,
      pkgs,
      ...
    }:
    {
      devShells.default = pkgs.mkShell {
        packages = [
          nodejs
          pkgs.git
          config.treefmt.build.wrapper
        ];

        shellHook = ''
          git config core.hooksPath .husky
        '';
      };
    };
}
