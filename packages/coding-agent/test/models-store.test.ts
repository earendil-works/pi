import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FileModelsStore } from "../src/core/models-store.ts";

const sharedTempDir = join(tmpdir(), `pi-models-store-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const sharedModelsPath = join(sharedTempDir, "models-store.json");

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("FileModelsStore", () => {
	it("persists provider catalogs without replacing unrelated providers", async () => {
		const store = new FileModelsStore(sharedModelsPath);

		await store.write("one", { models: [model("one", "m1")], checkedAt: 100 });
		await store.write("two", { models: [model("two", "m2")], checkedAt: 200 });

		const reloaded = new FileModelsStore(sharedModelsPath);
		expect((await reloaded.read("one"))?.models.map((entry) => entry.id)).toEqual(["m1"]);
		expect((await reloaded.read("one"))?.checkedAt).toBe(100);
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);

		await reloaded.delete("one");
		expect(await reloaded.read("one")).toBeUndefined();
		expect((await reloaded.read("two"))?.models.map((entry) => entry.id)).toEqual(["m2"]);
	});

	it("coalesces file reloads across concurrent readers and interleaved storage instances", async () => {
		writeFileSync(
			sharedModelsPath,
			JSON.stringify({
				one: { models: [model("one", "old")] },
				two: { models: [model("two", "m2")] },
			}),
		);
		const first = new FileModelsStore(sharedModelsPath);
		const second = new FileModelsStore(sharedModelsPath);
		const lockSpy = vi.spyOn(lockfile, "lock");

		const [one, two, missing] = await Promise.all([
			first.read("one", { signal: new AbortController().signal }),
			second.read("two", { signal: new AbortController().signal }),
			first.read("missing", { signal: new AbortController().signal }),
		]);
		expect(one?.models.map((entry) => entry.id)).toEqual(["old"]);
		expect(two?.models.map((entry) => entry.id)).toEqual(["m2"]);
		expect(missing).toBeUndefined();
		expect(lockSpy).toHaveBeenCalledTimes(1);

		await expect(second.read("one")).resolves.toMatchObject({ models: [{ id: "old" }] });
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const otherPath = join(sharedTempDir, "other-models-store.json");
		writeFileSync(otherPath, "{}");
		const other = new FileModelsStore(otherPath);
		await expect(other.read("one")).resolves.toBeUndefined();
		await expect(other.read("one")).resolves.toBeUndefined();
		const third = new FileModelsStore(sharedModelsPath);
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "newest-model")] } }));
		const [firstReload, thirdReload] = await Promise.all([first.read("one"), third.read("one")]);
		expect(firstReload).toMatchObject({ models: [{ id: "newest-model" }] });
		expect(thirdReload).toMatchObject({ models: [{ id: "newest-model" }] });
		expect(lockSpy).toHaveBeenCalledTimes(3);
	});

	it("keeps a coalesced reload alive while another reader is still waiting", async () => {
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "stored")] } }));
		const store = new FileModelsStore(sharedModelsPath);
		let grantLock: (() => void) | undefined;
		const lockGranted = new Promise<void>((resolve) => {
			grantLock = resolve;
		});
		const release = vi.fn(async () => {});
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			await lockGranted;
			return release;
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = store.read("one", { signal: firstController.signal });
		const second = store.read("one", { signal: secondController.signal });

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		grantLock?.();
		await expect(second).resolves.toMatchObject({ models: [{ id: "stored" }] });
		expect(lockSpy).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("cancels a catalog write waiting for a held file lock without writing later", async () => {
		writeFileSync(sharedModelsPath, JSON.stringify({ one: { models: [model("one", "existing")] } }));
		const store = new FileModelsStore(sharedModelsPath);
		const release = await lockfile.lock(sharedModelsPath, { realpath: false });
		const controller = new AbortController();
		const pending = store.write("two", { models: [model("two", "cancelled")] }, { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));

		const stored = JSON.parse(readFileSync(sharedModelsPath, "utf8")) as Record<string, unknown>;
		expect(stored.one).toBeDefined();
		expect(stored.two).toBeUndefined();
	});
});
