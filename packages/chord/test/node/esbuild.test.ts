// Tests of esbuild's idle stop (`src/node/esbuild.ts`): the service process lives while builds run and for the idle
// time after the last one, is stopped then, and starts again with the next build; a build under way keeps it.
import { readdirSync, readFileSync } from "node:fs";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { esbuildBuild } from "../../src/node/esbuild.ts";

/** Whether this process has an esbuild child process (Linux: `/proc`). */
function serviceRuns(): boolean {
	const pids = readdirSync("/proc/self/task").flatMap((task) =>
		readFileSync(`/proc/self/task/${task}/children`, "utf8").split(" ").filter(Boolean),
	);
	return pids.some((pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "esbuild");
}

/** Whether the service is gone within a few event loop turns (its child is reaped asynchronously). */
async function serviceStops(): Promise<boolean> {
	for (let turn = 0; turn < 1000; turn++) {
		if (!serviceRuns()) return true;
		await tick();
	}
	return false;
}

/** A build of a one-line module, in memory. */
const tiny = () =>
	esbuildBuild({ stdin: { contents: "export const x = 1;" }, write: false, bundle: true, format: "esm" });

/** A build of a module that does not parse. */
const broken = () => esbuildBuild({ stdin: { contents: "export {" }, write: false, logLevel: "silent" });

describe.skipIf(process.platform !== "linux")("esbuild's idle stop", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops the service once no build ran for 2 s, and the next build starts it again", async () => {
		await Promise.all([tiny(), tiny()]);
		vi.advanceTimersByTime(1999);
		// The stop is still to come (a child just stopped is listed until it is reaped: the timer tells).
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1);
		expect(vi.getTimerCount()).toBe(0);
		expect(await serviceStops()).toBe(true);
		const again = await tiny();
		expect(again.outputFiles?.[0]?.text).toContain("x = 1");
		expect(serviceRuns()).toBe(true);
	});

	it("keeps the service while one build is held and a sibling fails past the idle time; stops after a failed one (Astra)", async () => {
		// Catches a stop after any build ends instead of after the last one.
		await tiny();
		const started = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const slow = esbuildBuild({
			stdin: { contents: "export const x = 1;" },
			write: false,
			plugins: [
				{
					name: "hold",
					setup(builder) {
						builder.onStart(async () => {
							started.resolve();
							await held.promise;
						});
					},
				},
			],
		});
		await started.promise;
		await expect(broken()).rejects.toThrow();
		// No stop is due while a build runs.
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(2500);
		held.resolve();
		expect((await slow).outputFiles?.[0]?.text).toContain("x = 1");
		vi.advanceTimersByTime(2000);
		expect(await serviceStops()).toBe(true);
		await expect(broken()).rejects.toThrow();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(2000);
		expect(await serviceStops()).toBe(true);
	});

	it("restarts the idle time with every build: one running past an earlier build's idle time completes", async () => {
		// The review's reproduction: a build, 1.5 s, then a build whose load takes past the 2 s; it was a direct esbuild
		// build in p2's server (stopped with the service), now every build in the process is counted.
		await tiny();
		vi.advanceTimersByTime(1500);
		const loaded = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const slow = esbuildBuild({
			stdin: { contents: 'export { y } from "slow";', resolveDir: "/" },
			write: false,
			bundle: true,
			format: "esm",
			plugins: [
				{
					name: "slow",
					setup(builder) {
						builder.onResolve({ filter: /^slow$/ }, () => ({ path: "slow", namespace: "slow" }));
						builder.onLoad({ filter: /.*/, namespace: "slow" }, async () => {
							loaded.resolve();
							await held.promise;
							return { contents: "export const y = 2;", loader: "js" };
						});
					},
				},
			],
		});
		await loaded.promise;
		vi.advanceTimersByTime(1000);
		held.resolve();
		expect((await slow).outputFiles?.[0]?.text).toContain("y = 2");
	});
});
