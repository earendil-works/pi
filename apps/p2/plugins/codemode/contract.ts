import { local } from "@p2/app/v1";

/** Heap cap of each script's djs VM: scripts run on the session worker's thread, which they must not take down. */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * The worker's code mode sandbox (host-internal): one per worker. Removing the plugin cancels the scripts running on it;
 * a reload or a worker stop leaves them to resume from their dumps.
 */
export const CodemodeRuntime = local("p2.codemode-runtime", { version: 2, params: {}, members: {} });
