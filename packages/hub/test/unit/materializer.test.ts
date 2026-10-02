import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../src/types.ts";

let tmpDir: string;
let agentDir: string;
let mat: typeof import("../../src/materializer.ts");

function setup() {
	vi.resetModules();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hub-mat-test-"));
	process.env.PI_HUB_PI_DIR = tmpDir;
	process.env.PI_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
	process.env.PI_HUB_DIR = path.join(tmpDir, "pi-hub");
	process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
	agentDir = path.join(tmpDir, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
}

async function load() {
	mat = await import("../../src/materializer.ts");
}

function teardown() {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.PI_HUB_PI_DIR;
	delete process.env.PI_HUB_PROFILES_FILE;
	delete process.env.PI_HUB_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

const baseProfile: Profile = {
	provider: "kimi-coding",
	model: "kimi-for-coding",
	models: ["kimi-for-coding"],
	thinking: "high",
	token: "sk-test-token-1234567890",
	url: "https://proxy.example.com/coding",
};

describe("materializeProfile", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("creates the profile dir and returns its path", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		expect(dir).toBe(path.join(tmpDir, "pi-hub", "profiles", "work"));
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("writes auth.json with an api_key entry for the profile provider (0600)", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
		expect(auth["kimi-coding"]).toEqual({ type: "api_key", key: "sk-test-token-1234567890" });
		const mode = fs.statSync(path.join(dir, "auth.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("omits auth.json when the profile has no token", () => {
		const dir = mat.materializeProfile("oauth", { provider: "kimi-coding" });
		expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
	});

	it("preserves existing auth.json when the profile has no token", () => {
		// A provider login (`profile add -p`) writes OAuth credentials into the
		// profile's auth.json; re-materialization runs on every launch and must
		// not wipe them.
		const dir = mat.materializeProfile("oauth", { provider: "kimi-coding" });
		const authFile = path.join(dir, "auth.json");
		const credentials = { "kimi-coding": { type: "oauth", refresh: "r", access: "a", expires: 1 } };
		fs.writeFileSync(authFile, JSON.stringify(credentials));

		mat.materializeProfile("oauth", { provider: "kimi-coding" });
		expect(JSON.parse(fs.readFileSync(authFile, "utf-8"))).toEqual(credentials);
	});

	it("keys auth.json under the agent defaultProvider when the profile has no provider", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "kimi-coding" }));
		const dir = mat.materializeProfile("implicit", { model: "kimi-k2.7", token: "tok-123" });
		const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
		expect(auth["kimi-coding"]).toEqual({ type: "api_key", key: "tok-123" });
	});

	it("keys auth.json under the provider/model id prefix when present", () => {
		const dir = mat.materializeProfile("prefixed", { model: "openai/gpt-4o", token: "tok-123" });
		const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf-8"));
		expect(auth["openai"]).toEqual({ type: "api_key", key: "tok-123" });
	});

	it("warns and skips auth.json when no provider can be determined", () => {
		const errors: string[] = [];
		const origError = console.error;
		console.error = (...a: unknown[]) => errors.push(a.join(" "));
		try {
			const dir = mat.materializeProfile("noprovider", { model: "m", token: "tok-123" });
			expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
			expect(errors.some((e) => e.includes("no provider could be determined"))).toBe(true);
		} finally {
			console.error = origError;
		}
	});

	it("writes models.json under the agent defaultProvider when the profile has no provider", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "kimi-coding" }));
		const dir = mat.materializeProfile("implicit-url", { model: "kimi-k2.7", url: "https://api.kimi.com/coding/" });
		const models = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
		expect(models).toEqual({ providers: { "kimi-coding": { baseUrl: "https://api.kimi.com/coding/" } } });
	});

	it("writes settings.json with provider/model/thinking defaults", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.defaultProvider).toBe("kimi-coding");
		expect(settings.defaultModel).toBe("kimi-for-coding");
		expect(settings.defaultThinkingLevel).toBe("high");
	});

	it("preserves existing agent settings keys while overriding defaults", () => {
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", defaultProvider: "google", someHook: { x: 1 } }),
		);
		const dir = mat.materializeProfile("work", baseProfile);
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.theme).toBe("dark");
		expect(settings.someHook).toEqual({ x: 1 });
		expect(settings.defaultProvider).toBe("kimi-coding");
	});

	it("does not inherit source defaultProvider/defaultModel/defaultThinkingLevel when the profile lacks them", () => {
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				defaultProvider: "kimi-coding",
				defaultModel: "kimi-for-coding",
				defaultThinkingLevel: "high",
			}),
		);
		const dir = mat.materializeProfile("bare", { token: "tok-123" });
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.theme).toBe("dark");
		expect(settings.defaultProvider).toBeUndefined();
		expect(settings.defaultModel).toBeUndefined();
		expect(settings.defaultThinkingLevel).toBeUndefined();
	});

	it("lets an explicit profile.settings defaultProvider/defaultModel through", () => {
		const dir = mat.materializeProfile("custom", {
			settings: { defaultProvider: "google", defaultModel: "gemini-2.5-pro" },
		});
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.defaultProvider).toBe("google");
		expect(settings.defaultModel).toBe("gemini-2.5-pro");
	});

	it("carries the outer ~/.pi settings.json skills key when agent settings lack it", () => {
		fs.writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({ skills: ["~/.claude/skills"] }));
		const dir = mat.materializeProfile("work", baseProfile);
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.skills).toEqual(["~/.claude/skills"]);
	});

	it("merges profile.settings over the source agent settings", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", notify: true }));
		const dir = mat.materializeProfile("work", {
			...baseProfile,
			settings: { theme: "light", nested: { a: 1 } },
		});
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.theme).toBe("light");
		expect(settings.nested).toEqual({ a: 1 });
		expect(settings.notify).toBe(true);
		// Source file untouched
		const source = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(source.theme).toBe("dark");
		expect(source.nested).toBeUndefined();
	});

	it("deletes a source settings key when profile.settings sets it to null", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", keep: 1 }));
		const dir = mat.materializeProfile("work", {
			...baseProfile,
			settings: { theme: null },
		});
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.theme).toBeUndefined();
		expect(settings.keep).toBe(1);
	});

	it("lets the provider/model/thinking fields win over profile.settings for their keys", () => {
		const dir = mat.materializeProfile("work", {
			...baseProfile,
			settings: { defaultModel: "other-model", extra: "x" },
		});
		const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
		expect(settings.defaultModel).toBe("kimi-for-coding");
		expect(settings.extra).toBe("x");
	});

	it("preserves pi runtime state from the existing profile settings.json", () => {
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", lastChangelogVersion: "0.80.0", packages: ["npm:old"] }),
		);
		const dir = mat.materializeProfile("work", baseProfile);
		// Simulate pi writing runtime state during a session
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.theme = "claude-code-light/claude-code-dark-ansi";
		existing.lastChangelogVersion = "0.85.1";
		existing.modelThinkingLevels = { "kimi-coding/kimi-for-coding": "low" };
		existing.tuiMode = "fullscreen";
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		// Re-materialize: pi-written state must survive, not be reset from source
		mat.materializeProfile("work", baseProfile);
		const settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.theme).toBe("claude-code-light/claude-code-dark-ansi");
		expect(settings.lastChangelogVersion).toBe("0.85.1");
		expect(settings.packages).toEqual(["npm:old"]);
		expect(settings.modelThinkingLevels).toEqual({ "kimi-coding/kimi-for-coding": "low" });
		expect(settings.tuiMode).toBe("fullscreen");
	});

	it("adopts pi-written packages edits into the source on re-materialization", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:old"] }));
		const dir = mat.materializeProfile("work", baseProfile);
		// Simulate `pipi install` under the profile: the package lands in the
		// shared npm dir, and pi persists the new source into the profile copy
		// (e.g. the process died before the exit sync could write it back)
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.packages = ["npm:old", "npm:new"];
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		mat.materializeProfile("work", baseProfile);
		const sourceSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(sourceSettings.packages).toEqual(["npm:old", "npm:new"]);
		// and the regenerated profile copy tracks the adopted source
		const settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.packages).toEqual(["npm:old", "npm:new"]);
	});

	it("keeps profile settings over source edits on re-materialization, except untouched packages", () => {
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", statusbar: { enabled: false }, packages: ["npm:a"] }),
		);
		const dir = mat.materializeProfile("work", baseProfile);
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.theme = "claude-code-dark";
		existing.statusbar = { enabled: true, preset: "full" };
		existing.customKey = { any: "thing" };
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		// User edits the source settings — the profile file must win, and the
		// untouched packages list keeps tracking the source
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ theme: "light", statusbar: { enabled: false }, packages: ["npm:a", "npm:c"] }),
		);
		mat.materializeProfile("work", baseProfile);
		const settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.theme).toBe("claude-code-dark");
		expect(settings.statusbar).toEqual({ enabled: true, preset: "full" });
		expect(settings.customKey).toEqual({ any: "thing" });
		expect(settings.packages).toEqual(["npm:a", "npm:c"]);
	});

	it("lets profile packages edits win over concurrent source edits (last writer wins)", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:a"] }));
		const dir = mat.materializeProfile("work", baseProfile);
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.packages = ["npm:a", "npm:b"];
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		// Source edited concurrently (e.g. plain `pi remove` in another shell)
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:a", "npm:c"] }));
		mat.materializeProfile("work", baseProfile);
		// The profile-side edit is newer, so it is adopted; npm:c is dropped
		const sourceSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(sourceSettings.packages).toEqual(["npm:a", "npm:b"]);
	});

	it("always replicates hooks from the source agent settings", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ hooks: { sessionStart: "echo hi" } }));
		// Even an explicit hooks entry in the profile's settings map must lose.
		const dir = mat.materializeProfile("work", {
			...baseProfile,
			settings: { hooks: { sessionStart: "echo nope" } },
		});
		const profileSettings = path.join(dir, "settings.json");
		let settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.hooks).toEqual({ sessionStart: "echo hi" });

		// A hooks copy written into the profile file (pi runtime or hand edit)
		// must not shadow later edits to the default settings.json.
		settings.hooks = { sessionStart: "echo stale" };
		fs.writeFileSync(profileSettings, JSON.stringify(settings));
		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ hooks: { sessionStart: "echo updated" } }),
		);
		mat.materializeProfile("work", baseProfile);
		settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.hooks).toEqual({ sessionStart: "echo updated" });
	});

	it("lets profile.settings overrides win over preserved profile settings", () => {
		const dir = mat.materializeProfile("work", {
			...baseProfile,
			settings: { theme: "light" },
		});
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.theme = "claude-code-dark";
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		mat.materializeProfile("work", { ...baseProfile, settings: { theme: "light" } });
		const settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.theme).toBe("light");
	});

	it("regenerates from source when the existing profile settings.json is corrupt", () => {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const dir = mat.materializeProfile("work", baseProfile);
		const profileSettings = path.join(dir, "settings.json");
		fs.writeFileSync(profileSettings, "{ not json");

		expect(() => mat.materializeProfile("work", baseProfile)).not.toThrow();
		const settings = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		expect(settings.theme).toBe("dark");
		expect(settings.defaultProvider).toBe("kimi-coding");
	});

	it("writes models.json with a baseUrl override for the profile provider", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		const models = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf-8"));
		expect(models).toEqual({ providers: { "kimi-coding": { baseUrl: "https://proxy.example.com/coding" } } });
	});

	it("removes a stale models.json when the profile url is removed", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		expect(fs.existsSync(path.join(dir, "models.json"))).toBe(true);
		mat.writeModelsFile(dir, { provider: "kimi-coding", token: "t" });
		expect(fs.existsSync(path.join(dir, "models.json"))).toBe(false);
	});

	it("symlinks shared agent dirs and files into the profile dir", () => {
		fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
		fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "# agents");
		const dir = mat.materializeProfile("work", baseProfile);

		for (const name of ["extensions", "sessions", "AGENTS.md"]) {
			const link = path.join(dir, name);
			expect(fs.existsSync(link)).toBe(true);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(agentDir, name)));
		}
	});

	it("refreshes stale symlinks on re-materialization", () => {
		fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		const dir = mat.materializeProfile("work", baseProfile);
		// Simulate a stale symlink pointing at a moved location
		const sessionsLink = path.join(dir, "sessions");
		fs.rmSync(sessionsLink);
		fs.symlinkSync("/nonexistent-old-path", sessionsLink, "junction");

		mat.refreshSharedLinks(dir);
		expect(fs.realpathSync(sessionsLink)).toBe(fs.realpathSync(path.join(agentDir, "sessions")));
	});

	it("replaces a stale copied dir with a symlink on re-materialization", () => {
		fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "sessions", "shared.jsonl"), "{}");
		const dir = mat.materializeProfile("work", baseProfile);
		// Simulate a leftover from a copy fallback: a real dir instead of a link
		fs.rmSync(path.join(dir, "sessions"));
		fs.mkdirSync(path.join(dir, "sessions"));
		fs.writeFileSync(path.join(dir, "sessions", "stale-copy.jsonl"), "{}");

		mat.refreshSharedLinks(dir);
		const link = path.join(dir, "sessions");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(agentDir, "sessions")));
		expect(fs.existsSync(path.join(link, "shared.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(link, "stale-copy.jsonl"))).toBe(false);
	});

	it("is idempotent", () => {
		mat.materializeProfile("work", baseProfile);
		const dir = mat.materializeProfile("work", baseProfile);
		expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "settings.json"))).toBe(true);
	});
});

describe("refreshSharedLinks self-link guard", () => {
	beforeEach(() => {
		setup();
	});
	afterEach(teardown);

	it("is a no-op when AGENT_DIR equals the profile dir (nested launch)", async () => {
		// Simulate a nested launch under a materialized profile: the child pi
		// process inherits PI_CODING_AGENT_DIR=<profile dir>, so AGENT_DIR ===
		// the dir being refreshed. Without the guard, removeStaleLink would
		// delete the profile's real sessions dir mid-parent-run.
		const dir = path.join(tmpDir, "pi-hub", "profiles", "kimi");
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(dir, "sessions", "parent-session.jsonl"), "{}");
		process.env.PI_CODING_AGENT_DIR = dir;
		await load();

		mat.refreshSharedLinks(dir);

		expect(fs.lstatSync(path.join(dir, "sessions")).isDirectory()).toBe(true);
		expect(fs.existsSync(path.join(dir, "sessions", "parent-session.jsonl"))).toBe(true);
	});
});

describe("syncProfilePackagesToSource", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	function writeSourceSettings(settings: unknown): void {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	}

	it("copies the profile packages into the source, preserving other source keys", () => {
		writeSourceSettings({ theme: "dark", packages: ["npm:a", "npm:b"] });
		const dir = mat.materializeProfile("work", baseProfile);
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		existing.packages = ["npm:a"];
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		expect(mat.syncProfilePackagesToSource(dir)).toBe(true);
		const sourceSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(sourceSettings.packages).toEqual(["npm:a"]);
		expect(sourceSettings.theme).toBe("dark");
	});

	it("removes packages from the source when the profile copy has none", () => {
		writeSourceSettings({ packages: ["npm:a"] });
		const dir = mat.materializeProfile("work", baseProfile);
		const profileSettings = path.join(dir, "settings.json");
		const existing = JSON.parse(fs.readFileSync(profileSettings, "utf-8"));
		delete existing.packages;
		fs.writeFileSync(profileSettings, JSON.stringify(existing));

		expect(mat.syncProfilePackagesToSource(dir)).toBe(true);
		const sourceSettings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
		expect(sourceSettings.packages).toBeUndefined();
	});

	it("is a no-op when the packages already match", () => {
		writeSourceSettings({ packages: ["npm:a"] });
		const dir = mat.materializeProfile("work", baseProfile);
		const sourcePath = path.join(agentDir, "settings.json");
		const before = fs.readFileSync(sourcePath, "utf-8");

		expect(mat.syncProfilePackagesToSource(dir)).toBe(false);
		expect(fs.readFileSync(sourcePath, "utf-8")).toBe(before);
	});

	it("returns false when the source settings file does not exist", () => {
		const dir = mat.materializeProfile("work", baseProfile);
		expect(mat.syncProfilePackagesToSource(dir)).toBe(false);
	});
});

describe("removeProfileDir", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("removes the profile dir without following symlinks", () => {
		fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
		const dir = mat.materializeProfile("work", baseProfile);
		expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);

		mat.removeProfileDir("work");
		expect(fs.existsSync(dir)).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);
	});

	it("is a no-op for a missing profile dir", () => {
		expect(() => mat.removeProfileDir("ghost")).not.toThrow();
	});
});
