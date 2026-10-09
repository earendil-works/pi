{
  inputs,
  self,
  ...
}:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem =
    { lib, ... }:
    let
      inherit (lib) importJSON;
    in
    {
      treefmt = {
        projectRootFile = "flake.nix";
        programs = {
          biome = {
            enable = true;
            formatCommand = "format";
            settings = (importJSON "${self}/biome.json") // {
              plugins = [ "${self}/scripts/biome/model-type-comparison.grit" ];
            };
          };
          deadnix.enable = true;
          nixfmt.enable = true;
          statix.enable = true;
        };
      };
    };
}
