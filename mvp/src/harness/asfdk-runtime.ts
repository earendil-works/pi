// Vendored from NeuroLift-Technologies/asfdk-harness src/asfdk-runtime.ts @ f28136d1cece7f5dd20734020346075efc2f6d9d
// Only change from upstream: relative import specifiers use .ts (repo check:ts-imports). Do not edit otherwise: re-sync from upstream. See mvp/src/harness/README.md.
let asfdkPromise: Promise<typeof import("@neurolift-technologies/asfdk")> | undefined;

export function loadAsfdk(): Promise<typeof import("@neurolift-technologies/asfdk")> {
  if (!asfdkPromise) {
    asfdkPromise = import("@neurolift-technologies/asfdk");
  }

  return asfdkPromise;
}
