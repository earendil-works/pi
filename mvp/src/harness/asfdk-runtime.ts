// Vendored from NeuroLift-Technologies/asfdk-harness src/asfdk-runtime.ts @ 5488262c96d97026b27703d6580da65c2bcb1fb6
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
let asfdkPromise: Promise<typeof import("@neurolift-technologies/asfdk")> | undefined;

export function loadAsfdk(): Promise<typeof import("@neurolift-technologies/asfdk")> {
  if (!asfdkPromise) {
    asfdkPromise = import("@neurolift-technologies/asfdk");
  }

  return asfdkPromise;
}
