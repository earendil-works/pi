import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const prototype = InteractiveMode.prototype as unknown as {
	requestReload(this: RuntimeFixture): void;
	checkReloadRequested(this: RuntimeFixture): Promise<void>;
};

type RuntimeFixture = {
	shutdownRequested: boolean;
	reloadRequested: boolean;
	reloadInProgress: boolean;
	session: { isIdle: boolean; isCompacting: boolean };
	handleReloadCommand: ReturnType<typeof vi.fn>;
	checkReloadRequested: ReturnType<typeof vi.fn>;
};

function createFixture(isIdle: boolean): RuntimeFixture {
	return {
		shutdownRequested: false,
		reloadRequested: false,
		reloadInProgress: false,
		session: { isIdle, isCompacting: false },
		handleReloadCommand: vi.fn(async () => {}),
		checkReloadRequested: vi.fn(async () => {}),
	};
}

describe("InteractiveMode extension reload requests", () => {
	it("schedules a canonical reload when already idle", async () => {
		const fixture = createFixture(true);

		prototype.requestReload.call(fixture);
		await Promise.resolve();

		expect(fixture.reloadRequested).toBe(true);
		expect(fixture.checkReloadRequested).toHaveBeenCalledTimes(1);
	});

	it("defers until idle and then uses the built-in reload handler", async () => {
		const fixture = createFixture(false);
		prototype.requestReload.call(fixture);
		expect(fixture.checkReloadRequested).not.toHaveBeenCalled();

		fixture.session.isIdle = true;
		await prototype.checkReloadRequested.call(fixture);

		expect(fixture.reloadRequested).toBe(false);
		expect(fixture.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	it("defers across compaction and runs after compaction ends", async () => {
		const fixture = createFixture(true);
		fixture.session.isCompacting = true;
		prototype.requestReload.call(fixture);
		expect(fixture.checkReloadRequested).not.toHaveBeenCalled();

		fixture.session.isCompacting = false;
		await prototype.checkReloadRequested.call(fixture);

		expect(fixture.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	it("gives shutdown precedence over a queued reload", async () => {
		const fixture = createFixture(true);
		fixture.reloadRequested = true;
		fixture.shutdownRequested = true;

		await prototype.checkReloadRequested.call(fixture);

		expect(fixture.handleReloadCommand).not.toHaveBeenCalled();
	});

	it("coalesces requests while a reload is already running", () => {
		const fixture = createFixture(true);
		fixture.reloadInProgress = true;

		prototype.requestReload.call(fixture);

		expect(fixture.reloadRequested).toBe(false);
		expect(fixture.checkReloadRequested).not.toHaveBeenCalled();
	});
});
