import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function storageWithScopes(global: unknown, project?: unknown): InMemorySettingsStorage {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	if (project !== undefined) {
		storage.withLock("project", () => JSON.stringify(project));
	}
	return storage;
}

describe("SettingsManager compaction profiles", () => {
	it("returns built-in defaults with no config", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});

	it("resolves identically without model arguments even when profiles exist", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 1000,
				profiles: { "faux/big-model": { reserveTokens: 900_000 } },
			},
		});
		expect(manager.getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 20000,
		});
	});

	it("profile hit overrides one field while the other falls back to top-level", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 500,
				profiles: { "faux/big-model": { reserveTokens: 400_000 } },
			},
		});
		expect(manager.getCompactionSettings("faux", "big-model")).toEqual({
			enabled: true,
			reserveTokens: 400_000,
			keepRecentTokens: 500,
		});
	});

	it("top-level values fall back to defaults when unset", () => {
		const manager = SettingsManager.inMemory({
			compaction: { profiles: { "faux/big-model": {} } },
		});
		expect(manager.getCompactionSettings("faux", "big-model")).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});

	it("ignores a profile for the wrong provider or wrong model id", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				profiles: {
					"other-provider/big-model": { reserveTokens: 400_000 },
					"faux/other-model": { reserveTokens: 300_000 },
				},
			},
		});
		expect(manager.getCompactionSettings("faux", "big-model").reserveTokens).toBe(16384);
	});

	it("a profile for another model does not alter the queried model (INV4)", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 1000,
				profiles: { "faux/big-model": { reserveTokens: 400_000, keepRecentTokens: 123 } },
			},
		});
		expect(manager.getCompactionSettings("faux", "small-model")).toEqual({
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 20000,
		});
		expect(manager.getCompactionSettings("other-provider", "big-model").reserveTokens).toBe(1000);
	});

	it.each([
		["string value", "huge"],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("invalid profile field (%s) falls back to top-level", (_name, invalid) => {
		const manager = SettingsManager.inMemory({
			compaction: {
				reserveTokens: 1000,
				keepRecentTokens: 500,
				profiles: {
					"faux/big-model": { reserveTokens: invalid as number, keepRecentTokens: invalid as number },
				},
			},
		});
		expect(manager.getCompactionSettings("faux", "big-model")).toEqual({
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 500,
		});
	});

	it.each([
		["string value", "huge"],
		["zero", 0],
		["negative", -1],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("invalid top-level field (%s) falls back to default", (_name, invalid) => {
		const manager = SettingsManager.inMemory({
			compaction: { reserveTokens: invalid as number, keepRecentTokens: invalid as number },
		});
		expect(manager.getCompactionSettings("faux", "big-model")).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});

	it.each(["not-an-object", 42, [1, 2, 3]])("non-object profile entry %p is ignored", (entry) => {
		const manager = SettingsManager.inMemory({
			compaction: {
				profiles: { "faux/big-model": entry as never },
			},
		});
		expect(manager.getCompactionSettings("faux", "big-model").reserveTokens).toBe(16384);
	});

	it("merges project profiles into global profiles key-wise instead of clobbering", () => {
		const storage = storageWithScopes(
			{
				compaction: { profiles: { "faux/global-only": { reserveTokens: 111 } } },
			},
			{
				compaction: { profiles: { "faux/project-only": { reserveTokens: 222 } } },
			},
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings("faux", "global-only").reserveTokens).toBe(111);
		expect(manager.getCompactionSettings("faux", "project-only").reserveTokens).toBe(222);
	});

	it("project profile values win on key conflicts", () => {
		const storage = storageWithScopes(
			{
				compaction: { profiles: { "faux/shared": { reserveTokens: 111 } } },
			},
			{
				compaction: { profiles: { "faux/shared": { reserveTokens: 222 } } },
			},
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings("faux", "shared").reserveTokens).toBe(222);
	});
});
