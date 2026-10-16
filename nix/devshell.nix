{
  pkgs,
  nodejs,
  treefmtWrapper,
}:
pkgs.mkShell {
  packages = [
    nodejs
    pkgs.git
    treefmtWrapper
  ];

  shellHook = ''
    git config core.hooksPath .husky
  '';
}
