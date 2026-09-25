import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

function setup() {
	vi.resetModules();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hub-config-test-"));
	process.env.PI_HUB_PI_DIR = tmpDir;
	process.env.PI_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
	process.env.PI_HUB_DIR = path.join(tmpDir, "pi-hub");
	process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
}

function teardown() {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.PI_HUB_PI_DIR;
	delete process.env.PI_HUB_PROFILES_FILE;
	delete process.env.PI_HUB_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

async function getConfig() {
	return import("../../src/config.ts");
}

describe("config paths", () => {
	beforeEach(setup);
	afterEach(teardown);

	it("defaults profiles file under the pi dir", async () => {
		delete process.env.PI_HUB_PROFILES_FILE;
		vi.resetModules();
		const config = await getConfig();
		expect(config.PROFILES_FILE).toBe(path.join(tmpDir, "profiles.json"));
	});

	it("honours env overrides for all paths", async () => {
		const config = await getConfig();
		expect(config.PROFILES_FILE).toBe(path.join(tmpDir, "profiles.json"));
		expect(config.PI_HUB_DIR).toBe(path.join(tmpDir, "pi-hub"));
		expect(config.AGENT_DIR).toBe(path.join(tmpDir, "agent"));
		expect(config.PROFILE_DIRS_DIR).toBe(path.join(tmpDir, "pi-hub", "profiles"));
		expect(config.AGENT_SETTINGS_FILE).toBe(path.join(tmpDir, "agent", "settings.json"));
	});
});

describe("readJson / writeJson / ensureFile", () => {
	beforeEach(setup);
	afterEach(teardown);

	it("ensureFile creates parent dirs and default content", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "nested", "deep", "x.json");
		config.ensureFile(file, "{}\n");
		expect(fs.readFileSync(file, "utf-8")).toBe("{}\n");
	});

	it("ensureFile is a no-op when the file exists", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "x.json");
		fs.writeFileSync(file, "custom", "utf-8");
		config.ensureFile(file, "{}\n");
		expect(fs.readFileSync(file, "utf-8")).toBe("custom");
	});

	it("writeJson then readJson round-trips", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "data.json");
		config.writeJson(file, { a: 1, b: ["x", "y"] });
		expect(config.readJson(file)).toEqual({ a: 1, b: ["x", "y"] });
	});

	it("writeJson honours file mode", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "secret.json");
		config.writeJson(file, { token: "sk-x" }, 0o600);
		const mode = fs.statSync(file).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("writeJson leaves no tmp file behind (atomic rename)", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "atomic.json");
		config.writeJson(file, { a: 1 });
		expect(fs.readdirSync(tmpDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
		expect(config.readJson(file)).toEqual({ a: 1 });
	});

	it("writeJson replaces an existing file without exposing partial content", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "replace.json");
		config.writeJson(file, { a: 1 });
		config.writeJson(file, { a: 2, b: 3 });
		expect(config.readJson(file)).toEqual({ a: 2, b: 3 });
	});

	it("readJson retries when a concurrent non-atomic writer leaves the file momentarily empty", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "racy.json");
		fs.writeFileSync(file, '{"a":1}\n', "utf-8");
		const spy = vi.spyOn(fs, "readFileSync").mockImplementationOnce((() => "") as unknown as typeof fs.readFileSync);
		try {
			expect(config.readJson(file)).toEqual({ a: 1 });
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("readJson still throws after exhausting retries on corrupt content", async () => {
		const config = await getConfig();
		const file = path.join(tmpDir, "corrupt.json");
		fs.writeFileSync(file, "not json", "utf-8");
		expect(() => config.readJson(file)).toThrow();
	});

	it("ensureProfilesFile creates default profiles data", async () => {
		const config = await getConfig();
		config.ensureProfilesFile();
		expect(config.readJson<Record<string, unknown>>(config.PROFILES_FILE)).toEqual({ profiles: {} });
	});
});
