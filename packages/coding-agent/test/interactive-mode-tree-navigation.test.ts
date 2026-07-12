import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type TreeNavigationPromptFixture = {
	session: {
		isIdle: boolean;
		abort: () => Promise<void>;
	};
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	restoreQueuedMessagesToEditor: () => number;
};

const confirmAbortForTreeNavigation = (
	InteractiveMode as unknown as {
		prototype: {
			confirmAbortForTreeNavigation(this: TreeNavigationPromptFixture): Promise<boolean>;
		};
	}
).prototype.confirmAbortForTreeNavigation;

describe("InteractiveMode active-run tree navigation", () => {
	it("continues immediately when the session is idle", async () => {
		const fixture: TreeNavigationPromptFixture = {
			session: { isIdle: true, abort: vi.fn(async () => {}) },
			showExtensionSelector: vi.fn(async () => "Cancel"),
			restoreQueuedMessagesToEditor: vi.fn(() => 0),
		};

		await expect(confirmAbortForTreeNavigation.call(fixture)).resolves.toBe(true);
		expect(fixture.showExtensionSelector).not.toHaveBeenCalled();
		expect(fixture.session.abort).not.toHaveBeenCalled();
	});

	it("leaves the active run untouched when navigation is cancelled", async () => {
		const fixture: TreeNavigationPromptFixture = {
			session: { isIdle: false, abort: vi.fn(async () => {}) },
			showExtensionSelector: vi.fn(async () => "Cancel"),
			restoreQueuedMessagesToEditor: vi.fn(() => 0),
		};

		await expect(confirmAbortForTreeNavigation.call(fixture)).resolves.toBe(false);
		expect(fixture.showExtensionSelector).toHaveBeenCalledWith("Agent is running", ["Abort and navigate", "Cancel"]);
		expect(fixture.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(fixture.session.abort).not.toHaveBeenCalled();
	});

	it("restores queued input and waits for abort before navigation continues", async () => {
		const calls: string[] = [];
		const fixture: TreeNavigationPromptFixture = {
			session: {
				isIdle: false,
				abort: vi.fn(async () => {
					calls.push("abort");
				}),
			},
			showExtensionSelector: vi.fn(async () => "Abort and navigate"),
			restoreQueuedMessagesToEditor: vi.fn(() => {
				calls.push("restore");
				return 1;
			}),
		};

		await expect(confirmAbortForTreeNavigation.call(fixture)).resolves.toBe(true);
		expect(calls).toEqual(["restore", "abort"]);
	});
});
