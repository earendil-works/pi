/**
 * Worker entry for the codemode sandbox in bundled builds. The Node bundle and the Bun binary
 * build this file as a separate entrypoint because pi-codemode's own worker file is not on disk
 * there; `getCodemodeWorkerUrl()` in config.ts resolves it.
 */
import "@earendil-works/pi-codemode/worker";
