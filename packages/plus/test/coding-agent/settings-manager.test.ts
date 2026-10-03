/**
 * Tests for the hub-profile settings layering wrapper
 * (plus/src/coding-agent/core/settings-manager.ts): with PI_PLUS_BASE_AGENT_DIR
 * set, the global scope reads as base agent settings deep-merged under the
 * profile settings (profile wins), writes route per key (profile keys to the
 * profile file, general keys to the base file with profile shadows cleared),
 * the project layer still wins on top, reload picks up live base edits; the
 * same layering activates without the marker when the agent dir is itself a
 * hub profile dir (SDK hosts, manual PI_CODING_AGENT_DIR), and for any other
 * dir upstream single-file behavior is unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_BASE_AGENT_DIR } from "../../src/coding-agent/core/profile-settings.ts";
import { SettingsManager } from "../../src/coding-agent/core/settings-manager.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

interface Fixture {
	cwd: string;
	baseDir: string;
	profileDir: string;
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-layering-"));
	const cwd = path.join(root, "project");
	const baseDir = path.join(root, "agent");
	const profileDir = path.join(root, "pi-hub", "profiles", "work");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(baseDir, { recursive: true });
	fs.mkdirSync(profileDir, { recursive: true });
	return { cwd, baseDir, profileDir };
}

function writeJson(file: string, value: unknown): void {
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file: string): Record<string, unknown> {
	if (!fs.existsSync(file)) return {};
	return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
}

function activateProfile(fx: Fixture): void {
	process.env[ENV_BASE_AGENT_DIR] = fx.baseDir;
	process.env[ENV_AGENT_DIR] = fx.profileDir;
}

// Detection consults HOME (default ~/.pi layout) and the hub relocation vars;
// save and restore them so tests stay hermetic regardless of the ambient env.
const originalEnv = {
	HOME: process.env.HOME,
	PI_HUB_DIR: process.env.PI_HUB_DIR,
	PI_HUB_PI_DIR: process.env.PI_HUB_PI_DIR,
};

afterEach(() => {
	delete process.env[ENV_BASE_AGENT_DIR];
	delete process.env[ENV_AGENT_DIR];
	for (const [name, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("profile-layered settings reads", () => {
	it("merges base and profile layers with the profile winning", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), {
			theme: "dark",
			editorPaddingX: 1,
			retry: { enabled: true, maxRetries: 5 },
			defaultModel: "base-model",
		});
		writeJson(path.join(fx.profileDir, "settings.json"), {
			defaultModel: "profile-model",
			theme: "profile-theme",
			retry: { maxRetries: 2 },
		});
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		const global = mgr.getGlobalSettings();
		expect(global.theme).toBe("profile-theme");
		expect(global.defaultModel).toBe("profile-model");
		expect(global.editorPaddingX).toBe(1);
		expect(global.retry).toEqual({ enabled: true, maxRetries: 2 });
	});

	it("the project layer still wins over the merged global scope", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "dark" });
		writeJson(path.join(fx.profileDir, "settings.json"), { theme: "profile-theme" });
		fs.mkdirSync(path.join(fx.cwd, ".pi"), { recursive: true });
		writeJson(path.join(fx.cwd, ".pi", "settings.json"), { theme: "project-theme" });
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		expect(mgr.getTheme()).toBe("project-theme");
	});

	it("reload picks up live base-agent edits made outside the process", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "dark" });
		writeJson(path.join(fx.profileDir, "settings.json"), { defaultModel: "m" });
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		expect(mgr.getTheme()).toBe("dark");
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "light" });
		await mgr.reload();
		expect(mgr.getTheme()).toBe("light");
		expect(mgr.getDefaultModel()).toBe("m");
	});
});

describe("profile-layered settings writes", () => {
	it("routes profile keys to the profile file and leaves the base untouched", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), { defaultModel: "base-model", theme: "dark" });
		writeJson(path.join(fx.profileDir, "settings.json"), { defaultModel: "profile-model" });
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		mgr.setDefaultModel("new-model");
		await mgr.flush();

		const profile = readJson(path.join(fx.profileDir, "settings.json"));
		expect(profile.defaultModel).toBe("new-model");
		const base = readJson(path.join(fx.baseDir, "settings.json"));
		expect(base.defaultModel).toBe("base-model");
		expect(base.theme).toBe("dark");
	});

	it("routes general keys to the base file and clears a profile shadow copy", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "dark" });
		writeJson(path.join(fx.profileDir, "settings.json"), { theme: "profile-theme", defaultModel: "m" });
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		expect(mgr.getTheme()).toBe("profile-theme");
		mgr.setTheme("user-picked");
		await mgr.flush();

		const base = readJson(path.join(fx.baseDir, "settings.json"));
		expect(base.theme).toBe("user-picked");
		const profile = readJson(path.join(fx.profileDir, "settings.json"));
		expect(profile.theme).toBeUndefined();
		expect(profile.defaultModel).toBe("m");

		await mgr.reload();
		expect(mgr.getTheme()).toBe("user-picked");
	});

	it("writes a general key to the base file when neither layer has it", async () => {
		const fx = fixture();
		writeJson(path.join(fx.profileDir, "settings.json"), { defaultModel: "m" });
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		mgr.setTheme("fresh");
		await mgr.flush();

		expect(readJson(path.join(fx.baseDir, "settings.json")).theme).toBe("fresh");
		expect(readJson(path.join(fx.profileDir, "settings.json")).theme).toBeUndefined();
	});

	it("creates both layers on demand when neither file exists yet", async () => {
		const fx = fixture();
		activateProfile(fx);

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		mgr.setDefaultProvider("anthropic");
		mgr.setTheme("dark");
		await mgr.flush();

		expect(readJson(path.join(fx.profileDir, "settings.json"))).toEqual({ defaultProvider: "anthropic" });
		expect(readJson(path.join(fx.baseDir, "settings.json"))).toEqual({ theme: "dark" });
	});
});

describe("layering activates for hub profile dirs without the marker", () => {
	it("layers a profile dir under the default ~/.pi hub layout", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-auto-"));
		const cwd = path.join(home, "project");
		const baseDir = path.join(home, ".pi", "agent");
		const profileDir = path.join(home, ".pi", "pi-hub", "profiles", "work");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(baseDir, { recursive: true });
		fs.mkdirSync(profileDir, { recursive: true });
		writeJson(path.join(baseDir, "settings.json"), { theme: "dark" });
		writeJson(path.join(profileDir, "settings.json"), { defaultModel: "profile-model" });
		process.env.HOME = home; // no marker, no PI_CODING_AGENT_DIR — SDK-style call

		const mgr = SettingsManager.create(cwd, profileDir);
		expect(mgr.getGlobalSettings().theme).toBe("dark");
		expect(mgr.getGlobalSettings().defaultModel).toBe("profile-model");

		mgr.setDefaultModel("chosen");
		mgr.setTheme("light");
		await mgr.flush();
		expect(readJson(path.join(profileDir, "settings.json")).defaultModel).toBe("chosen");
		expect(readJson(path.join(baseDir, "settings.json")).theme).toBe("light");
	});

	it("honors PI_HUB_DIR for the profiles root", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-hubdirs-"));
		const cwd = path.join(home, "project");
		const hubRoot = path.join(home, "custom-hub");
		const profileDir = path.join(hubRoot, "profiles", "work");
		const baseDir = path.join(home, ".pi", "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(profileDir, { recursive: true });
		fs.mkdirSync(baseDir, { recursive: true });
		writeJson(path.join(profileDir, "settings.json"), { defaultModel: "hub-model" });
		writeJson(path.join(baseDir, "settings.json"), { theme: "dark" });
		process.env.PI_HUB_DIR = hubRoot;
		process.env.HOME = home;

		const mgr = SettingsManager.create(cwd, profileDir);
		expect(mgr.getGlobalSettings().defaultModel).toBe("hub-model");
		expect(mgr.getGlobalSettings().theme).toBe("dark");
	});

	it("keeps an explicit PI_CODING_AGENT_DIR as the base when it points elsewhere", async () => {
		const fx = fixture(); // profile at <root>/pi-hub/profiles/work, base at <root>/agent
		writeJson(path.join(fx.profileDir, "settings.json"), { defaultModel: "profile-model" });
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "dark" });
		process.env.PI_HUB_PI_DIR = path.dirname(path.dirname(path.dirname(fx.profileDir)));
		process.env[ENV_AGENT_DIR] = fx.baseDir;

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		expect(mgr.getGlobalSettings().theme).toBe("dark");
		expect(mgr.getGlobalSettings().defaultModel).toBe("profile-model");
	});
});

describe("layering stays inert outside profiles and markers", () => {
	it("reads and writes the single agent-dir file like upstream", async () => {
		const fx = fixture();
		process.env[ENV_AGENT_DIR] = fx.profileDir; // profile-shaped dir, but not under the hub root and no marker
		writeJson(path.join(fx.profileDir, "settings.json"), { theme: "solo" });
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "must-stay-untouched" });

		const mgr = SettingsManager.create(fx.cwd, fx.profileDir);
		expect(mgr.getTheme()).toBe("solo");
		mgr.setTheme("edited");
		await mgr.flush();

		expect(readJson(path.join(fx.profileDir, "settings.json")).theme).toBe("edited");
		expect(readJson(path.join(fx.baseDir, "settings.json")).theme).toBe("must-stay-untouched");
	});

	it("leaves the default agent dir untouched", async () => {
		const fx = fixture();
		writeJson(path.join(fx.baseDir, "settings.json"), { theme: "solo" });

		const mgr = SettingsManager.create(fx.cwd, fx.baseDir);
		expect(mgr.getTheme()).toBe("solo");
		mgr.setTheme("edited");
		await mgr.flush();
		expect(readJson(path.join(fx.baseDir, "settings.json")).theme).toBe("edited");
	});
});
