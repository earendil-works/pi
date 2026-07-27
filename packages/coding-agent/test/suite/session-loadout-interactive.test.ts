import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendSessionLoadout,
	getSessionLoadout,
	type LoadoutOverride,
	type LoadoutSnapshot,
} from "../../src/core/loadout.ts";
import type { SessionLoadoutSelection } from "../../src/modes/interactive/components/session-loadout-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const reference = {
	type: "skill" as const,
	origin: "top-level" as const,
	scope: "user" as const,
	relativePath: "skills/review/SKILL.md",
};
const overrides: LoadoutOverride[] = [{ reference, enabled: false }];

type RestoreContext = {
	loadoutRestoreDecisions: Set<string>;
	sessionManager: Harness["sessionManager"];
	getLoadoutRestoreDecisionKey: () => string;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	applySessionLoadout: (selection: SessionLoadoutSelection, persist: boolean) => Promise<void>;
};

type ApplyContext = {
	session: { isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean };
	sessionManager: Harness["sessionManager"];
	getLoadoutLoader: () => {
		getLoadoutSnapshot: () => LoadoutSnapshot;
		setLoadoutOverrides: (overrides: readonly LoadoutOverride[]) => void;
	};
	loadoutActionBlocked: (action: "opening" | "applying") => boolean;
	handleReloadCommand: () => Promise<boolean>;
	showLoadoutDiagnostics: () => void;
	showWarning: (message: string) => void;
};

type ReloadBlockedContext = {
	session: { isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean };
	showWarning: (message: string) => void;
};

type InteractiveModePrivate = {
	maybeRestoreSavedLoadout(this: RestoreContext): Promise<void>;
	applySessionLoadout(this: ApplyContext, selection: SessionLoadoutSelection, persist: boolean): Promise<void>;
	loadoutActionBlocked(this: Pick<ApplyContext, "session" | "showWarning">, action: "opening" | "applying"): boolean;
	handleReloadCommand(this: ReloadBlockedContext): Promise<boolean>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
const harnesses: Harness[] = [];

async function createTestHarness(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("interactive session loadout restore", () => {
	it("accepts a saved loadout once per live runtime without appending", async () => {
		const harness = await createTestHarness();
		appendSessionLoadout(harness.sessionManager, overrides);
		const entryCount = harness.sessionManager.getEntries().length;
		const showExtensionConfirm = vi.fn(async () => true);
		const applySessionLoadout = vi.fn(async () => {});
		const context: RestoreContext = {
			loadoutRestoreDecisions: new Set(),
			sessionManager: harness.sessionManager,
			getLoadoutRestoreDecisionKey: () => harness.sessionManager.getSessionId(),
			showExtensionConfirm,
			applySessionLoadout,
		};

		await interactiveModePrototype.maybeRestoreSavedLoadout.call(context);
		await interactiveModePrototype.maybeRestoreSavedLoadout.call(context);

		expect(showExtensionConfirm).toHaveBeenCalledOnce();
		expect(applySessionLoadout).toHaveBeenCalledWith({ overrides, explicitReset: false }, false);
		expect(harness.sessionManager.getEntries()).toHaveLength(entryCount);
	});

	it("remembers a declined restore and ignores reset or fresh sessions", async () => {
		const declinedHarness = await createTestHarness();
		appendSessionLoadout(declinedHarness.sessionManager, overrides);
		const showExtensionConfirm = vi.fn(async () => false);
		const applySessionLoadout = vi.fn(async () => {});
		const declined: RestoreContext = {
			loadoutRestoreDecisions: new Set(),
			sessionManager: declinedHarness.sessionManager,
			getLoadoutRestoreDecisionKey: () => declinedHarness.sessionManager.getSessionId(),
			showExtensionConfirm,
			applySessionLoadout,
		};
		await interactiveModePrototype.maybeRestoreSavedLoadout.call(declined);
		await interactiveModePrototype.maybeRestoreSavedLoadout.call(declined);
		expect(showExtensionConfirm).toHaveBeenCalledOnce();
		expect(applySessionLoadout).not.toHaveBeenCalled();

		const resetHarness = await createTestHarness();
		appendSessionLoadout(resetHarness.sessionManager, overrides);
		appendSessionLoadout(resetHarness.sessionManager, []);
		const ignoredConfirm = vi.fn(async () => true);
		const reset: RestoreContext = {
			loadoutRestoreDecisions: new Set(),
			sessionManager: resetHarness.sessionManager,
			getLoadoutRestoreDecisionKey: () => resetHarness.sessionManager.getSessionId(),
			showExtensionConfirm: ignoredConfirm,
			applySessionLoadout,
		};
		await interactiveModePrototype.maybeRestoreSavedLoadout.call(reset);
		expect(ignoredConfirm).not.toHaveBeenCalled();

		const freshHarness = await createTestHarness();
		const fresh: RestoreContext = {
			loadoutRestoreDecisions: new Set(),
			sessionManager: freshHarness.sessionManager,
			getLoadoutRestoreDecisionKey: () => freshHarness.sessionManager.getSessionId(),
			showExtensionConfirm: ignoredConfirm,
			applySessionLoadout,
		};
		await interactiveModePrototype.maybeRestoreSavedLoadout.call(fresh);
		expect(ignoredConfirm).not.toHaveBeenCalled();
	});
});

describe("interactive reload blocking", () => {
	it("blocks ordinary reload while direct user bash is running", async () => {
		const showWarning = vi.fn();
		await interactiveModePrototype.handleReloadCommand.call({
			session: { isStreaming: false, isCompacting: false, isBashRunning: true },
			showWarning,
		});
		expect(showWarning).toHaveBeenCalledWith("Wait for the bash command to finish before reloading.");
	});
});

describe("interactive /loadout application", () => {
	it("persists a deliberate change, reloads once, and reports unmatched resources", async () => {
		const harness = await createTestHarness();
		const setLoadoutOverrides = vi.fn();
		const handleReloadCommand = vi.fn(async () => true);
		const showWarning = vi.fn();
		const snapshot: LoadoutSnapshot = {
			resources: [],
			overrides: [],
			diagnostics: [{ type: "warning", message: "Saved loadout skill is unavailable" }],
		};
		const context: ApplyContext = {
			session: { isStreaming: false, isCompacting: false, isBashRunning: false },
			sessionManager: harness.sessionManager,
			getLoadoutLoader: () => ({ getLoadoutSnapshot: () => snapshot, setLoadoutOverrides }),
			loadoutActionBlocked(action) {
				return interactiveModePrototype.loadoutActionBlocked.call(this, action);
			},
			handleReloadCommand,
			showLoadoutDiagnostics() {
				for (const diagnostic of snapshot.diagnostics) this.showWarning(diagnostic.message);
			},
			showWarning,
		};

		await interactiveModePrototype.applySessionLoadout.call(context, { overrides, explicitReset: false }, true);

		expect(setLoadoutOverrides).toHaveBeenCalledWith(overrides);
		expect(handleReloadCommand).toHaveBeenCalledOnce();
		expect(getSessionLoadout(harness.sessionManager)?.overrides).toEqual(overrides);
		expect(showWarning).toHaveBeenCalledWith("Saved loadout skill is unavailable");
	});

	it("writes a reset tombstone when reset is explicit after a declined restore", async () => {
		const harness = await createTestHarness();
		appendSessionLoadout(harness.sessionManager, overrides);
		const entryCount = harness.sessionManager.getEntries().length;
		const setLoadoutOverrides = vi.fn();
		const context: ApplyContext = {
			session: { isStreaming: false, isCompacting: false, isBashRunning: false },
			sessionManager: harness.sessionManager,
			getLoadoutLoader: () => ({
				getLoadoutSnapshot: () => ({ resources: [], overrides: [], diagnostics: [] }),
				setLoadoutOverrides,
			}),
			loadoutActionBlocked: () => false,
			handleReloadCommand: async () => true,
			showLoadoutDiagnostics: () => {},
			showWarning: vi.fn(),
		};

		await interactiveModePrototype.applySessionLoadout.call(context, { overrides: [], explicitReset: true }, true);

		expect(setLoadoutOverrides).toHaveBeenCalledWith([]);
		expect(harness.sessionManager.getEntries()).toHaveLength(entryCount + 1);
		expect(getSessionLoadout(harness.sessionManager)?.overrides).toEqual([]);
	});

	it("does not write a reset tombstone for an unchanged apply after a declined restore", async () => {
		const harness = await createTestHarness();
		appendSessionLoadout(harness.sessionManager, overrides);
		const entryCount = harness.sessionManager.getEntries().length;
		const setLoadoutOverrides = vi.fn();
		const context: ApplyContext = {
			session: { isStreaming: false, isCompacting: false, isBashRunning: false },
			sessionManager: harness.sessionManager,
			getLoadoutLoader: () => ({
				getLoadoutSnapshot: () => ({ resources: [], overrides: [], diagnostics: [] }),
				setLoadoutOverrides,
			}),
			loadoutActionBlocked: () => false,
			handleReloadCommand: async () => true,
			showLoadoutDiagnostics: () => {},
			showWarning: vi.fn(),
		};

		await interactiveModePrototype.applySessionLoadout.call(context, { overrides: [], explicitReset: false }, true);

		expect(setLoadoutOverrides).toHaveBeenCalledWith([]);
		expect(harness.sessionManager.getEntries()).toHaveLength(entryCount);
		expect(getSessionLoadout(harness.sessionManager)?.overrides).toEqual(overrides);
	});

	it("rolls back in-memory overrides and persistence when reload fails", async () => {
		const harness = await createTestHarness();
		const setLoadoutOverrides = vi.fn();
		const context: ApplyContext = {
			session: { isStreaming: false, isCompacting: false, isBashRunning: false },
			sessionManager: harness.sessionManager,
			getLoadoutLoader: () => ({
				getLoadoutSnapshot: () => ({ resources: [], overrides: [], diagnostics: [] }),
				setLoadoutOverrides,
			}),
			loadoutActionBlocked: () => false,
			handleReloadCommand: async () => false,
			showLoadoutDiagnostics: vi.fn(),
			showWarning: vi.fn(),
		};

		await interactiveModePrototype.applySessionLoadout.call(context, { overrides, explicitReset: false }, true);

		expect(setLoadoutOverrides).toHaveBeenNthCalledWith(1, overrides);
		expect(setLoadoutOverrides).toHaveBeenNthCalledWith(2, []);
		expect(getSessionLoadout(harness.sessionManager)).toBeUndefined();
		expect(context.showLoadoutDiagnostics).not.toHaveBeenCalled();
	});

	it.each([
		["streaming", { isStreaming: true, isCompacting: false, isBashRunning: false }],
		["compaction", { isStreaming: false, isCompacting: true, isBashRunning: false }],
		["bash", { isStreaming: false, isCompacting: false, isBashRunning: true }],
	])("blocks application during %s", async (_name, session) => {
		const harness = await createTestHarness();
		const setLoadoutOverrides = vi.fn();
		const handleReloadCommand = vi.fn(async () => true);
		const showWarning = vi.fn();
		const context: ApplyContext = {
			session,
			sessionManager: harness.sessionManager,
			getLoadoutLoader: () => ({
				getLoadoutSnapshot: () => ({ resources: [], overrides: [], diagnostics: [] }),
				setLoadoutOverrides,
			}),
			loadoutActionBlocked(action) {
				return interactiveModePrototype.loadoutActionBlocked.call(this, action);
			},
			handleReloadCommand,
			showLoadoutDiagnostics: () => {},
			showWarning,
		};

		await interactiveModePrototype.applySessionLoadout.call(context, { overrides, explicitReset: false }, true);

		expect(setLoadoutOverrides).not.toHaveBeenCalled();
		expect(handleReloadCommand).not.toHaveBeenCalled();
		expect(getSessionLoadout(harness.sessionManager)).toBeUndefined();
		expect(showWarning).toHaveBeenCalledOnce();
	});
});
