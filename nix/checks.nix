{
  pkgs,
  pi,
  source,
  nodejs,
}:
{
  smoke =
    pkgs.runCommand "pi-smoke-test"
      {
        nativeBuildInputs = [ pi ];
      }
      ''
        export HOME=$(mktemp -d)
        pi --version
        pi --help > /dev/null
        touch $out
      '';

  repo-hygiene =
    pkgs.runCommand "pi-repo-hygiene-check"
      {
        nativeBuildInputs = [ nodejs ];
      }
      ''
        cd ${source}
        node scripts/check-pinned-deps.mjs
        node scripts/check-entry-graphs.mjs
        node scripts/generate-coding-agent-install-lock.mjs --check
        touch $out
      '';
}
