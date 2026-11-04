import { local } from "@p2/app/v1";

/**
 * Heap cap of each script's QuickJS VM. Keep it constant across restarts: the limit is part of the VM's fingerprint,
 * which Durable records when a script starts, and a script interrupted by a restart resumes only on a VM with the same
 * fingerprint. A changed limit makes every interrupted script end with "the sandbox changed" instead of resuming.
 */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * The worker's code mode sandbox (host-internal): one per worker, closed when the plugin is removed or the worker
 * stops; a reload opens a new one and drains the old one in the background (its scripts run on). Each running script
 * holds one worker thread; closing aborts them.
 */
export const CodemodeRuntime = local("p2.codemode-runtime", { version: 2, params: {}, members: {} });
