// Pins the fork's catalog snapshot seam: PI_FORK_CATALOG_SNAPSHOT replaces all fetches; unset keeps the live path.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalogSources } from "../catalog/sources/index.ts";

describe("catalog snapshot sources", () => {
	let dir: string;
	const original = process.env.PI_FORK_CATALOG_SNAPSHOT;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "catalog-snapshot-"));
	});

	afterEach(() => {
		if (original === undefined) delete process.env.PI_FORK_CATALOG_SNAPSHOT;
		else process.env.PI_FORK_CATALOG_SNAPSHOT = original;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the snapshot without fetching and rebuilds the NVIDIA map", async () => {
		const fetchMock = vi.fn(() => Promise.reject(new Error("network used")));
		vi.stubGlobal("fetch", fetchMock);
		const file = join(dir, "snapshot.json");
		const snapshot = {
			modelsDev: { nvidia: { models: {} } },
			modelsDevDecisions: { a: { id: "a" } },
			openRouter: { chat: [], images: [{ id: "i" }], classifiers: [] },
			aiGateway: { chat: [], classifiers: [] },
			nvidiaModelIds: [
				["Foo_Bar", "Foo_Bar"],
				["foo.bar", "Foo_Bar"],
			],
			radius: [{ id: "r" }],
		};
		writeFileSync(file, JSON.stringify(snapshot));
		process.env.PI_FORK_CATALOG_SNAPSHOT = file;

		const sources = await loadCatalogSources(true);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sources.nvidiaModelIds).toBeInstanceOf(Map);
		expect(sources.nvidiaModelIds.get("foo.bar")).toBe("Foo_Bar");
		expect(sources.modelsDev).toEqual(snapshot.modelsDev);
		expect(sources.modelsDevDecisions).toEqual(snapshot.modelsDevDecisions);
		expect(sources.openRouter).toEqual(snapshot.openRouter);
		expect(sources.aiGateway).toEqual(snapshot.aiGateway);
		expect(sources.radius).toEqual(snapshot.radius);
	});

	it("keeps the live path when the variable is unset", async () => {
		delete process.env.PI_FORK_CATALOG_SNAPSHOT;
		const fetchMock = vi.fn(() => Promise.reject(new Error("blocked")));
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(loadCatalogSources(true)).rejects.toThrow("blocked");
		expect(fetchMock).toHaveBeenCalled();
	});
});
