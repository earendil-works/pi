/**
 * Closed-network fork: main() forces outbound-call suppression unconditionally,
 * whatever SPI_OFFLINE / SPI_SKIP_VERSION_CHECK held before the process started.
 * Upstream treats these as opt-in; here there must be no way to switch them off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";

describe("main() closed-network env forcing", () => {
	const originalOffline = process.env.SPI_OFFLINE;
	const originalSkipVersionCheck = process.env.SPI_SKIP_VERSION_CHECK;

	beforeEach(() => {
		// Values that would disable suppression if main() honoured them.
		process.env.SPI_OFFLINE = "0";
		process.env.SPI_SKIP_VERSION_CHECK = "0";
	});

	afterEach(() => {
		if (originalOffline === undefined) delete process.env.SPI_OFFLINE;
		else process.env.SPI_OFFLINE = originalOffline;
		if (originalSkipVersionCheck === undefined) delete process.env.SPI_SKIP_VERSION_CHECK;
		else process.env.SPI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
		vi.restoreAllMocks();
	});

	/**
	 * Runs main() far enough to execute the env-forcing lines at the top of its
	 * body. Short-lived commands may exit the process, which would kill the test
	 * worker, so process.exit is replaced with a sentinel throw.
	 */
	async function runMain(args: string[]): Promise<void> {
		const exited = Symbol("exited");
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw exited;
		}) as never);

		try {
			await main(args);
		} catch (error) {
			if (error !== exited) throw error;
		}
	}

	it("forces both flags on even when preset to disable them", async () => {
		await runMain(["install", "--help"]);

		expect(process.env.SPI_OFFLINE).toBe("1");
		expect(process.env.SPI_SKIP_VERSION_CHECK).toBe("1");
	});

	it("forces both flags on when they are unset beforehand", async () => {
		delete process.env.SPI_OFFLINE;
		delete process.env.SPI_SKIP_VERSION_CHECK;

		await runMain(["install", "--help"]);

		expect(process.env.SPI_OFFLINE).toBe("1");
		expect(process.env.SPI_SKIP_VERSION_CHECK).toBe("1");
	});

	it("forces both flags on even when --offline was never passed", async () => {
		await runMain(["--version"]);

		expect(process.env.SPI_OFFLINE).toBe("1");
		expect(process.env.SPI_SKIP_VERSION_CHECK).toBe("1");
	});
});
