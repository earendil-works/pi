import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("extensions: runtime provider registration", () => {
	it("registers provider/models on load and cleans them up on unload", async () => {
		vi.resetModules();

		vi.doMock("os", () => ({
			homedir: () => "/tmp/mu-home-extension-provider-reg",
		}));

		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => [],
			getModels: () => [],
			getApiKey: () => undefined,
		}));

		const { loadAndMergeModels } = await import("../src/model-config.js");

		const { ExtensionLoader } = await import("../src/extensions/loader.js");
		const { ExtensionManager } = await import("../src/extensions/manager.js");

		const projectDir = await mkdtemp(join(tmpdir(), "mu-ext-provider-project-"));
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });

		const extPath = join(extDir, "ext.ts");
		await writeFile(
			extPath,
			`
export default function (mu) {
  mu.registerProvider("acme", {
    baseUrl: "https://api.acme.test/v1",
    apiKey: "ACME_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "acme-1",
        name: "Acme One",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      }
    ]
  });
}
`,
			"utf8",
		);

		const mgr = new ExtensionManager({ builtInTools: {} });
		const loader = new ExtensionLoader(mgr, { projectDir, configDir: join(projectDir, "_config") });

		const loaded = await loader.loadAll();
		expect(loaded.map((r) => r.ok)).toEqual([true]);

		const afterLoad = loadAndMergeModels();
		expect(afterLoad.error).toBeNull();
		expect(afterLoad.models.find((m) => m.provider === "acme" && m.id === "acme-1")?.name).toBe("Acme One");

		mgr.unloadAllExtensions();
		const afterUnload = loadAndMergeModels();
		expect(afterUnload.models.find((m) => m.provider === "acme" && m.id === "acme-1")).toBeUndefined();
	});
});
