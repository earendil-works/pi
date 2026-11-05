/**
 * The real `SandboxClient`, backed by the Vercel Sandbox SDK.
 *
 * Kept apart from `lifecycle.ts` so that the lifecycle logic and its tests never load the SDK. Calling the
 * returned client creates or resumes a real, billed sandbox using the project's Vercel credentials, so
 * nothing in the application calls this yet.
 */

import { Sandbox } from "@vercel/sandbox";
import type { SandboxClient } from "./lifecycle.ts";

export function createVercelSandboxClient(): SandboxClient {
  return {
    getOrCreate: (params) =>
      // `resume: true` wakes the existing sandbox if it has stopped, instead of failing.
      Sandbox.getOrCreate({
        name: params.name,
        persistent: params.persistent,
        timeout: params.timeout,
        resources: params.resources,
        networkPolicy: params.networkPolicy,
        keepLastSnapshots: params.keepLastSnapshots,
        resume: true,
      }),
  };
}
