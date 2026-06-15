{ lib, srcRoot }:

let
  fromRoot = path: srcRoot + path;
in
lib.fileset.toSource {
  root = srcRoot;
  fileset = lib.fileset.unions (map fromRoot [
    "/.npmrc"
    "/package-lock.json"
    "/package.json"
    "/packages/agent"
    "/packages/ai"
    "/packages/coding-agent"
    "/packages/tui"
    "/tsconfig.base.json"
  ]);
}
