/**
 * Closed-network security fork: main() must force outbound-call suppression
 * unconditionally, regardless of what SPI_OFFLINE / SPI_SKIP_VERSION_CHECK were
 * set to before the process started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

describe("main() closed-network env forcing", () => {
	const originalOffline = process.env.SPI_OFFLINE;
	const originalSkipVersionCheck = process.env.SPI_SKIP_VERSION_CHECK;

	beforeEach(() => {
		// Deliberately set both to values that would disable suppression if honored,
		// so we can prove main() overrides them regardless of prior state.
		process.env.SPI_OFFLINE = "0";
		process.env.SPI_SKIP_VERSION_CHECK = "0";
	});

	afterEach(() => {
		if (originalOffline === undefined) {
			delete process.env.SPI_OFFLINE;
		} else {
			process.env.SPI_OFFLINE = originalOffline;
		}
		if (originalSkipVersionCheck === undefined) {
			delete process.env.SPI_SKIP_VERSION_CHECK;
		} else {
			process.env.SPI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
		}
		vi.restoreAllMocks();
	});

	it("forces SPI_OFFLINE and SPI_SKIP_VERSION_CHECK to '1' even when preset to disable them", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			// A command path that resolves without process.exit(), so main()'s
			// full body runs (past the env-forcing lines) without killing the test worker.
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			expect(process.env.SPI_OFFLINE).toBe("1");
			expect(process.env.SPI_SKIP_VERSION_CHECK).toBe("1");
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("also forces suppression when the flags are unset beforehand", async () => {
		delete process.env.SPI_OFFLINE;
		delete process.env.SPI_SKIP_VERSION_CHECK;

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			expect(process.env.SPI_OFFLINE).toBe("1");
			expect(process.env.SPI_SKIP_VERSION_CHECK).toBe("1");
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});
});
