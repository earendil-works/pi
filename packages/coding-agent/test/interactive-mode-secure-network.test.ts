/**
 * Closed-network security fork: outbound non-LLM calls (version checks, package update
 * checks, session sharing) must stay suppressed whenever SPI_OFFLINE / SPI_SKIP_VERSION_CHECK
 * are set, regardless of what else is going on in the surrounding InteractiveMode instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode closed-network outbound suppression", () => {
	const originalOffline = process.env.SPI_OFFLINE;
	const originalSkipVersionCheck = process.env.SPI_SKIP_VERSION_CHECK;

	beforeEach(() => {
		delete process.env.SPI_OFFLINE;
		delete process.env.SPI_SKIP_VERSION_CHECK;
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

	describe("checkForNewVersion", () => {
		it("does not hit the npm registry and returns undefined when SPI_OFFLINE is set", async () => {
			process.env.SPI_OFFLINE = "1";
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			const fakeThis: any = { version: "0.0.1" };

			const result = await (InteractiveMode as any).prototype.checkForNewVersion.call(fakeThis);

			expect(result).toBeUndefined();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("does not hit the npm registry and returns undefined when SPI_SKIP_VERSION_CHECK is set", async () => {
			process.env.SPI_SKIP_VERSION_CHECK = "1";
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			const fakeThis: any = { version: "0.0.1" };

			const result = await (InteractiveMode as any).prototype.checkForNewVersion.call(fakeThis);

			expect(result).toBeUndefined();
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("attempts the npm registry check when neither suppression flag is set", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in test"));
			const fakeThis: any = { version: "0.0.1" };

			const result = await (InteractiveMode as any).prototype.checkForNewVersion.call(fakeThis);

			// Confirms the two env vars are the actual gate, not some other always-off mechanism.
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(result).toBeUndefined();
		});
	});

	describe("checkForPackageUpdates", () => {
		it("returns no updates without touching session/settings state when SPI_OFFLINE is set", async () => {
			process.env.SPI_OFFLINE = "1";
			// Deliberately empty: if the gate didn't short-circuit, touching
			// sessionManager/settingsManager below would throw.
			const fakeThis: any = {};

			const result = await (InteractiveMode as any).prototype.checkForPackageUpdates.call(fakeThis);

			expect(result).toEqual([]);
		});
	});

	describe("handleShareCommand (/share)", () => {
		it("shows the closed-network error and does not proceed to GitHub CLI checks when SPI_OFFLINE is set", async () => {
			process.env.SPI_OFFLINE = "1";
			const showError = vi.fn();
			// No `session`, `editorContainer`, etc.: if the gate didn't return early,
			// the subsequent gist-export code would throw on these missing fields.
			const fakeThis: any = { showError };

			await (InteractiveMode as any).prototype.handleShareCommand.call(fakeThis);

			expect(showError).toHaveBeenCalledTimes(1);
			expect(showError).toHaveBeenCalledWith(
				"Session sharing is not available in closed-network mode (SPI_OFFLINE is set).",
			);
		});
	});
});
