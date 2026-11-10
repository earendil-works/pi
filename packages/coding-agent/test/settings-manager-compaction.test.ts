import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "provider", id: "family/model" };
const modelKey = "provider/family/model";
const defaults = SETTINGS_DEFAULTS.compaction;

// Regression coverage for #8133: model policy overrides resolve independently of ordinary settings.
describe("compaction model overrides", () => {
	it("resolves each percentage and budget independently", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				prepareThreshold: 60,
				threshold: 90,
				maxSummaryTokens: 3000,
				keepRecentTokens: 10000,
				modelOverrides: { [modelKey]: { threshold: 80 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			prepareThreshold: 60,
			threshold: 80,
			maxSummaryTokens: 3000,
			keepRecentTokens: 10000,
		});
		expect(manager.getCompactionSettings().threshold).toBe(90);
		manager.applyOverrides({
			compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 30000, maxSummaryTokens: 6000 } } },
		});
		expect(manager.getCompactionSettings(model)).toMatchObject({
			threshold: 80,
			maxSummaryTokens: 6000,
			keepRecentTokens: 30000,
		});
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("matches exact provider/model IDs and falls back per missing field", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				modelOverrides: {
					[modelKey]: { threshold: 80, keepRecentTokens: 1024 },
					"provider/*": { threshold: 90 },
					"family/model": { threshold: 95 },
				},
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, threshold: 80, keepRecentTokens: 1024 });
		for (const other of [
			{ provider: "other", id: model.id },
			{ provider: model.provider, id: "other" },
			{ provider: model.provider, id: "family/Model" },
		]) {
			expect(manager.getCompactionSettings(other)).toEqual(defaults);
		}
	});

	it("merges project model overrides before resolving ordinary fallbacks and honors project trust", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					prepareThreshold: 65,
					threshold: 90,
					modelOverrides: {
						[modelKey]: { threshold: 80, keepRecentTokens: 30000 },
						"provider/other": { keepRecentTokens: 4096 },
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: {
					prepareThreshold: 70,
					threshold: 95,
					modelOverrides: { [modelKey]: { keepRecentTokens: 2000 } },
				},
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			prepareThreshold: 70,
			threshold: 80,
			keepRecentTokens: 2000,
		});
		expect(manager.getCompactionSettings({ provider: "provider", id: "other" })).toEqual({
			...defaults,
			prepareThreshold: 70,
			threshold: 95,
			keepRecentTokens: 4096,
		});
		await manager.reload();
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(2000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			prepareThreshold: 65,
			threshold: 80,
			keepRecentTokens: 30000,
		});
	});

	it("keeps enabled global and persists model policy when saving the toggle", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { modelOverrides: { [modelKey]: { enabled: false, threshold: 80 } } } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model).enabled).toBe(true);
		manager.setCompactionEnabled(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, enabled: false, threshold: 80 });
	});

	it.each([
		["prepareThreshold", -1],
		["threshold", 101],
		["threshold", 0],
		["maxSummaryTokens", 0],
		["maxSummaryTokens", "1000"],
		["keepRecentTokens", 1.5],
		["keepRecentTokens", null],
	] as const)("rejects invalid %s values at the settings-file boundary", (field, value) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { modelOverrides: { [modelKey]: { [field]: value } } } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(() => manager.getCompactionSettings(model)).toThrow(field);
		expect(manager.getCompactionSettings()).toEqual(defaults);
	});

	it("rejects invalid ordinary values even if a model supplies a valid override", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { threshold: "85", modelOverrides: { [modelKey]: { threshold: 90 } } } }),
		);
		expect(() => SettingsManager.fromStorage(storage).getCompactionSettings(model)).toThrow("compaction.threshold");
	});

	it("rejects non-finite runtime overrides and inconsistent resolved thresholds", () => {
		const manager = SettingsManager.inMemory();
		manager.applyOverrides({ compaction: { threshold: Number.NaN } });
		expect(() => manager.getCompactionSettings()).toThrow("threshold");
		manager.applyOverrides({
			compaction: { threshold: 80, modelOverrides: { [modelKey]: { prepareThreshold: 90 } } },
		});
		expect(() => manager.getCompactionSettings(model)).toThrow("prepareThreshold");
		expect(manager.getCompactionSettings().threshold).toBe(80);
	});

	it.each([null, false, 42, "invalid", []])("rejects malformed model entries: %j", (entry) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [modelKey]: entry } } }));
		expect(() => SettingsManager.fromStorage(storage).getCompactionSettings(model)).toThrow("modelOverrides");
	});

	it("allows immediate preparation and retaining no recent manual-compaction messages", () => {
		const manager = SettingsManager.inMemory({
			compaction: { prepareThreshold: 0, threshold: 1, maxSummaryTokens: 1, keepRecentTokens: 0 },
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			prepareThreshold: 0,
			threshold: 1,
			maxSummaryTokens: 1,
			keepRecentTokens: 0,
		});
	});

	it("retires absolute-token triggers on load and removes them on the next settings write", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					reserveTokens: 400000,
					keepRecentTokens: 1200,
					modelOverrides: { [modelKey]: { reserveTokens: 2000, keepRecentTokens: 2400 } },
				},
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 2400 });
		manager.setCompactionEnabled(false);
		await manager.flush();
		let persisted = "";
		storage.withLock("global", (value) => {
			persisted = value ?? "";
			return undefined;
		});
		expect(JSON.parse(persisted).compaction).toEqual({
			enabled: false,
			keepRecentTokens: 1200,
			modelOverrides: { [modelKey]: { keepRecentTokens: 2400 } },
		});
	});
});
