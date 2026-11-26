// Tests of esbuild's idle stop (`src/node/esbuild.ts`, the perf pass's waste 4): the service process lives while
// builds run and shortly after, is stopped once idle, and starts again with the next build.
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { build } from "../../src/node/esbuild.ts";

/** The names of this process's child processes (Linux: `/proc`). */
function children(): string[] {
	const pids = readdirSync("/proc/self/task").flatMap((task) =>
		readFileSync(`/proc/self/task/${task}/children`, "utf8").split(" ").filter(Boolean),
	);
	return pids.map((pid) => readFileSync(`/proc/${pid}/comm`, "utf8").trim());
}

/** A build of a one-line module, in memory. */
const tiny = () => build({ stdin: { contents: "export const x = 1;" }, write: false, bundle: true, format: "esm" });

describe.skipIf(process.platform !== "linux")("esbuild's service", () => {
	it("stops once no build ran for a while, and starts again with the next build", async () => {
		await tiny();
		expect(children()).toContain("esbuild");
		await Promise.all([tiny(), tiny()]);
		// Past the idle time (2 s) with no build: stopped.
		await sleep(2500);
		expect(children()).not.toContain("esbuild");
		const again = await tiny();
		expect(again.outputFiles?.[0]?.text).toContain("x = 1");
		expect(children()).toContain("esbuild");
	}, 10_000);

	it("stays while builds follow each other within the idle time", async () => {
		for (let round = 0; round < 3; round++) {
			await tiny();
			await sleep(1000);
			expect(children()).toContain("esbuild");
		}
	}, 10_000);
});
