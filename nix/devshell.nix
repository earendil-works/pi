{ devenv, inputs, pkgs, self }:

let
  nodejs = import ./nodejs.nix { inherit pkgs; };
in
devenv.lib.mkShell {
  inherit inputs pkgs;

  modules = [
    {
      # https://devenv.sh/reference/options/
      devenv.root =
        let
          pwd = builtins.getEnv "PWD";
        in
        if pwd != "" then pwd else self.outPath;

      languages.javascript = {
        enable = true;
        package = nodejs;
        npm.enable = true;
      };

      packages = [
        pkgs.fd
        pkgs.git
        pkgs.gnutar
        pkgs.ripgrep
        pkgs.unzip
      ];
    }
  ];
}
