// esbuild's service, stopped while idle: every build of Chord's goes through `build`, which counts the builds under
// way; once none ran for `IDLE_MS`, the service process (a Go child holding its heap, 61 MiB after a first apply) is
// stopped. The next build starts it again (a few milliseconds).

import { type BuildOptions, type BuildResult, build as esbuild, stop } from "esbuild";

/** How long the service stays after the last build ended: a batch's builds follow each other within it. */
const IDLE_MS = 2000;

/**
 * The process's builds under way and the timer of the idle stop: esbuild's service is one per process, so is its
 * count (state, not a cache).
 */
let running = 0;
let idle: NodeJS.Timeout | undefined;

/** esbuild's `build`, counted: the service stops once no build ran for `IDLE_MS`. */
export async function build<T extends BuildOptions>(options: T & BuildOptions): Promise<BuildResult<T>> {
	running++;
	clearTimeout(idle);
	idle = undefined;
	try {
		return await esbuild(options as Parameters<typeof esbuild<T>>[0]);
	} finally {
		if (--running === 0) {
			idle = setTimeout(stopIdle, IDLE_MS);
			// The process may end meanwhile: the timer keeps nothing alive.
			idle.unref();
		}
	}
}

/** Stops the service unless a build started since the timer was set. */
function stopIdle(): void {
	idle = undefined;
	if (running === 0) void stop();
}
