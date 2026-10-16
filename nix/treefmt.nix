{ pkgs, source }:
let
  biomeConfig = pkgs.writeText "biome.json" (
    builtins.toJSON (
      (pkgs.lib.importJSON "${source}/biome.json")
      // {
        plugins = [ "${source}/scripts/biome/model-type-comparison.grit" ];
      }
    )
  );
in
pkgs.treefmt.withConfig {
  runtimeInputs = [
    pkgs.biome
    pkgs.nixfmt
  ];
  settings = {
    global.tree_root_file = "flake.nix";
    formatter = {
      biome = {
        command = "biome";
        options = [
          "format"
          "--write"
          "--no-errors-on-unmatched"
          "--config-path"
          (builtins.toString biomeConfig)
        ];
        includes = [
          "*.cjs"
          "*.css"
          "*.cts"
          "*.graphql"
          "*.js"
          "*.json"
          "*.jsonc"
          "*.mjs"
          "*.mts"
          "*.ts"
        ];
      };
      nixfmt = {
        command = "nixfmt";
        includes = [ "*.nix" ];
      };
    };
  };
}
