// The pages' base bundle (Chord's web surface): its entry and how its packages resolve, one definition for the server,
// the Cloud Brain build (scripts/cloud-bundle.ts) and the test that it reads no package's `dist/`.

import { fileURLToPath } from "node:url";
import type { BaseResolution } from "@earendil-works/chord/surfaces";

/** The pages' start code (it calls `startP2Page`). */
export const WEB_ENTRY = fileURLToPath(new URL("./entry.ts", import.meta.url));

/**
 * As the server process resolves (src/source-resolver.ts): workspace packages through p2's tsconfig paths, their
 * sources, so a checkout that never builds `dist/` (the phone) builds its pages; the server's conditions otherwise.
 */
export const WEB_RESOLUTION = {
	tsconfig: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
} as const satisfies BaseResolution;
