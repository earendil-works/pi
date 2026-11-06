/**
 * TOI / OTOI file loading, server side only.
 *
 * Reads the owner's local `.toi` and `.otoi` files from the paths given by
 * `ASFDK_TOI_PATH` / `ASFDK_OTOI_PATH` (user-level env). Home-directory defaults
 * apply when those are unset. The files are never in any repo; they are the
 * owner's local authoring source.
 *
 * All reads return `undefined` (never throw) so callers fail closed: a missing
 * or unreadable file means the TOI/OTOI is unverifiable and the turn runs
 * without standing terms.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TOI_NAME = ".toi";
const DEFAULT_OTOI_NAME = ".otoi";

function defaultToiPath(): string {
  return join(homedir(), DEFAULT_TOI_NAME);
}

function defaultOtoIPath(): string {
  return join(homedir(), DEFAULT_OTOI_NAME);
}

/** Resolve the `.toi` path: `ASFDK_TOI_PATH` env, else home-directory default. */
export function resolveToiPath(env: { ASFDK_TOI_PATH?: string | undefined }): string {
  return env.ASFDK_TOI_PATH ?? defaultToiPath();
}

/** Resolve the `.otoi` path: `ASFDK_OTOI_PATH` env, else home-directory default. */
export function resolveOtoIPath(env: { ASFDK_OTOI_PATH?: string | undefined }): string {
  return env.ASFDK_OTOI_PATH ?? defaultOtoIPath();
}

/** Read the `.toi` file content, or `undefined` when it cannot be read. */
export async function loadToi(toiPath?: string): Promise<string | undefined> {
  const path = toiPath ?? defaultToiPath();
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Read the `.otoi` file content, or `undefined` when it cannot be read. */
export async function loadOtoI(otoiPath?: string): Promise<string | undefined> {
  const path = otoiPath ?? defaultOtoIPath();
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}