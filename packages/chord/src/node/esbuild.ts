// esbuild's service, stopped while idle: every build in a process that loads Chord goes through `esbuildBuild`, which
// counts the builds under way; once none ran for `IDLE_MS`, the service process (a Go child holding its heap, 57 MiB
// after a first apply) is stopped. The next build starts it again (a few milliseconds). The service is one per process:
// a build calling esbuild directly while the timer fires is stopped with it, so the app's own builds use this one too.

import { build as esbuild, stop } from "esbuild";

/** How long the service stays after the last build ended: a batch's builds follow each other within it. */
const IDLE_MS = 2000;

/**
 * The process's builds under way and the timer of the idle stop: esbuild's service is one per process, so is its
 * count (state, not a cache).
 */
let running = 0;
let idle: NodeJS.Timeout | undefined;

/** esbuild's `build`, counted: the service stops once no build ran for `IDLE_MS`. */
export const esbuildBuild: typeof esbuild = async (options) => {
	running++;
	clearTimeout(idle);
	try {
		return await esbuild(options);
	} finally {
		// The process may end meanwhile: the timer keeps nothing alive.
		if (--running === 0) idle = setTimeout(stop, IDLE_MS).unref();
	}
};
