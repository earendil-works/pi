/**
 * The working directory for the crisis gate.
 *
 * The ASFDK foundation's Sleepwalker component writes continuity files to a relative `.swp_storage`
 * directory and its storage path cannot be configured through the foundation, while serverless function
 * directories are read-only. So the process needs a writable working directory.
 *
 * It is chosen once per process and never changed again. The earlier design called `process.chdir()` on
 * every request, which races when requests overlap in a warm instance. This function is synchronous, so
 * the first caller sets the directory before anything else runs, and every later caller (including
 * overlapping requests) gets the same one without touching the process. Each request still uses its own
 * user id, so one caller's continuity state never influences another's.
 *
 * The one remaining process-wide effect is that relative paths in this function resolve under that
 * directory. Nothing else in this function uses relative paths: the sandbox tools use explicit remote
 * paths and the Pi session gets an explicit `cwd`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string | undefined;

/** Returns the process-wide working directory for the crisis gate, creating it once on first use. */
export function gateWorkDir(): string {
  if (workDir === undefined) {
    const created = mkdtempSync(join(tmpdir(), "nlt-gate-"));
    process.chdir(created);
    workDir = created;
  }
  return workDir;
}
