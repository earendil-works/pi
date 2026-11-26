// The benches' launched servers, each stopped whatever ends the bench: `launch` of `test/support.ts` spawns `p3 server`
// as a child that outlives its parent, so a bench that threw past its `finally`, crashed on an uncaught error or was
// interrupted used to leave its servers running. A launch here is stopped by the caller's `finally`; what is still
// running when the process exits (any exit: an uncaught error, `process.exit`) or gets SIGINT, SIGTERM or SIGHUP gets
// SIGTERM. Only SIGKILL of the bench escapes it.

import { type Launched, launch } from "../test/support.ts";

/** The servers launched and not yet stopped. */
const running = new Set<Launched>();

/** `p3 server` of `command` on `dataDir` launched as `launch` does, tracked until stopped. */
export async function launchTracked(
	command: readonly string[],
	dataDir: string,
	env: NodeJS.ProcessEnv,
): Promise<Launched> {
	const server = await launch(command, dataDir, env);
	running.add(server);
	return {
		...server,
		stop: async () => {
			try {
				await server.stop();
			} finally {
				running.delete(server);
			}
		},
	};
}

/** Runs `fn` with `server` and stops the server afterwards, whether `fn` returned or threw. */
export async function withServer<T>(server: Launched, fn: (server: Launched) => Promise<T>): Promise<T> {
	try {
		return await fn(server);
	} finally {
		await server.stop();
	}
}

// `exit` listeners run synchronously: `kill` sends the signal at once and does not wait.
process.once("exit", () => {
	for (const server of running) server.kill("SIGTERM");
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.once(signal, () => {
		for (const server of running) server.kill("SIGTERM");
		process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[signal]);
	});
}
