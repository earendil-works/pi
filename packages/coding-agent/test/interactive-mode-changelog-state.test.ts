import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ChangelogContext = {
	session: { state: { messages: unknown[] } };
	stateManager: {
		getLastChangelogVersion(): string | undefined;
		setLastChangelogVersion(version: string): void;
	};
	settingsManager: {
		getLastChangelogVersion(): string | undefined;
		setLastChangelogVersion(version: string): void;
	};
	reportInstallTelemetry(version: string): void;
};

describe("InteractiveMode changelog state", () => {
	const getChangelogForDisplay = (
		InteractiveMode.prototype as unknown as {
			getChangelogForDisplay(this: ChangelogContext): string | undefined;
		}
	).getChangelogForDisplay;

	it("records fresh install changelog acknowledgement in state, not settings", () => {
		const context: ChangelogContext = {
			session: { state: { messages: [] } },
			stateManager: {
				getLastChangelogVersion: vi.fn(() => undefined),
				setLastChangelogVersion: vi.fn(),
			},
			settingsManager: {
				getLastChangelogVersion: vi.fn(() => {
					throw new Error("settings should not be read");
				}),
				setLastChangelogVersion: vi.fn(() => {
					throw new Error("settings should not be written");
				}),
			},
			reportInstallTelemetry: vi.fn(),
		};

		expect(getChangelogForDisplay.call(context)).toBeUndefined();

		expect(context.stateManager.setLastChangelogVersion).toHaveBeenCalledWith(VERSION);
		expect(context.settingsManager.setLastChangelogVersion).not.toHaveBeenCalled();
		expect(context.reportInstallTelemetry).toHaveBeenCalledWith(VERSION);
	});

	it("reads update changelog acknowledgement from state", () => {
		const context: ChangelogContext = {
			session: { state: { messages: [] } },
			stateManager: {
				getLastChangelogVersion: vi.fn(() => "0.0.0"),
				setLastChangelogVersion: vi.fn(),
			},
			settingsManager: {
				getLastChangelogVersion: vi.fn(() => {
					throw new Error("settings should not be read");
				}),
				setLastChangelogVersion: vi.fn(() => {
					throw new Error("settings should not be written");
				}),
			},
			reportInstallTelemetry: vi.fn(),
		};

		const changelog = getChangelogForDisplay.call(context);

		expect(changelog).toContain("## [");
		expect(context.stateManager.setLastChangelogVersion).toHaveBeenCalledWith(VERSION);
		expect(context.settingsManager.getLastChangelogVersion).not.toHaveBeenCalled();
		expect(context.settingsManager.setLastChangelogVersion).not.toHaveBeenCalled();
	});
});
