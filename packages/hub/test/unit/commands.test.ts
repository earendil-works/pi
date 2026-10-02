import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let hub: typeof import("../../src/index.ts");

function setup() {
	vi.resetModules();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hub-cmds-test-"));
	process.env.PI_HUB_PI_DIR = tmpDir;
	process.env.PI_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
	process.env.PI_HUB_DIR = path.join(tmpDir, "pi-hub");
	process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
	fs.mkdirSync(path.join(tmpDir, "agent"), { recursive: true });
}

async function load() {
	hub = await import("../../src/index.ts");
}

function teardown() {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	delete process.env.PI_HUB_PI_DIR;
	delete process.env.PI_HUB_PROFILES_FILE;
	delete process.env.PI_HUB_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
}

/** Capture console.log / console.error output for the duration of fn(). */
async function capture(fn: () => void | Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const origLog = console.log;
	const origError = console.error;
	console.log = (...args: unknown[]) => stdout.push(args.join(" "));
	console.error = (...args: unknown[]) => stderr.push(args.join(" "));
	try {
		await fn();
	} finally {
		console.log = origLog;
		console.error = origError;
	}
	return { stdout, stderr };
}

describe("dispatchHubCommand", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("profile add saves a profile with models and prints confirmation", async () => {
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand([
				"profile",
				"add",
				"work",
				"-p",
				"kimi-coding",
				"-m",
				"kimi-k2.7",
				"-t",
				"tok-1234567890abcdef",
				"--thinking",
				"high",
			]);
		});
		expect(stdout).toContain("Profile 'work' saved.");
		const data = hub.loadProfiles();
		expect(data.profiles.work).toEqual({
			provider: "kimi-coding",
			model: "kimi-k2.7",
			models: ["kimi-k2.7"],
			thinking: "high",
			token: "tok-1234567890abcdef",
		});
	});

	it("profile add rejects more than 3 models", async () => {
		expect(() => hub.dispatchHubCommand(["profile", "add", "x", "-m", "a", "-m", "b", "-m", "c", "-m", "d"])).toThrow(
			"at most 3 models",
		);
	});

	it("profile add rejects an invalid thinking level", async () => {
		expect(() => hub.dispatchHubCommand(["profile", "add", "x", "--thinking", "nope"])).toThrow(
			"Invalid thinking level",
		);
	});

	it("profile add with only a provider invokes the injected login", async () => {
		const calls: { profileDir: string; provider: string }[] = [];
		const { stdout } = await capture(() =>
			hub.dispatchHubCommand(["profile", "add", "anth", "-p", "kimi-coding"], {
				login: async (context) => {
					calls.push(context);
				},
			}),
		);
		expect(stdout).toContain("Profile 'anth' saved.");
		expect(stdout.some((l) => l.includes("invoking the 'kimi-coding' login"))).toBe(true);
		expect(stdout).toContain("Logged in to 'kimi-coding'.");
		expect(calls).toHaveLength(1);
		expect(calls[0].provider).toBe("kimi-coding");
		expect(fs.existsSync(calls[0].profileDir)).toBe(true);
		expect(hub.loadProfiles().profiles.anth).toEqual({ provider: "kimi-coding" });
	});

	it("profile add keeps the profile when the login is cancelled", async () => {
		const { stderr } = await capture(() =>
			hub.dispatchHubCommand(["profile", "add", "anth", "-p", "kimi-coding"], {
				login: async () => {
					throw new Error("Login cancelled");
				},
			}),
		);
		expect(stderr.some((l) => l.includes("Login did not complete: Login cancelled"))).toBe(true);
		expect(hub.loadProfiles().profiles.anth).toEqual({ provider: "kimi-coding" });
	});

	it("profile add with a token does not invoke login", async () => {
		let called = false;
		await capture(() =>
			hub.dispatchHubCommand(["profile", "add", "anth", "-p", "kimi-coding", "-t", "tok-1234567890abcdef"], {
				login: async () => {
					called = true;
				},
			}),
		);
		expect(called).toBe(false);
	});

	it("profile add with only a provider and no injected login stores the profile", async () => {
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "anth", "-p", "kimi-coding"]);
		});
		expect(stdout).toContain("Profile 'anth' saved.");
		expect(stdout.some((l) => l.includes("login"))).toBe(false);
		expect(hub.loadProfiles().profiles.anth).toEqual({ provider: "kimi-coding" });
	});

	it("profile add parses --set key=value and applies --unset", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "x", "--set", "theme=light", "--set", "retries=3"]);
		});
		let p = hub.loadProfiles().profiles.x;
		expect(p.settings).toEqual({ theme: "light", retries: 3 });

		await capture(() => {
			hub.dispatchHubCommand(["profile", "update", "x", "--unset", "theme"]);
		});
		p = hub.loadProfiles().profiles.x;
		expect(p.settings).toEqual({ retries: 3 });
	});

	it("profile update selects an existing model and unshifts a new one", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "x", "-m", "m1", "-m", "m2"]);
		});
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "update", "x", "-m", "m2"]);
		});
		expect(stdout.some((l) => l.includes("position 2 -> 1"))).toBe(true);
		expect(hub.loadProfiles().profiles.x.models).toEqual(["m2", "m1"]);

		await capture(() => {
			hub.dispatchHubCommand(["profile", "update", "x", "-m", "m3"]);
		});
		expect(hub.loadProfiles().profiles.x.models).toEqual(["m3", "m2", "m1"]);
	});

	it("profile update --delete-model removes models", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "x", "-m", "m1", "-m", "m2"]);
		});
		await capture(() => {
			hub.dispatchHubCommand(["profile", "update", "x", "-d", "m1"]);
		});
		const p = hub.loadProfiles().profiles.x;
		expect(p.models).toEqual(["m2"]);
		expect(p.model).toBe("m2");
	});

	it("profile update throws for an unknown profile", () => {
		expect(() => hub.dispatchHubCommand(["profile", "update", "ghost", "-m", "m1"])).toThrow("not found");
	});

	it("profile list marks the default profile with an asterisk", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
			hub.dispatchHubCommand(["profile", "add", "play", "-m", "m2"]);
			hub.dispatchHubCommand(["use", "work"]);
		});
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "list"]);
		});
		const workLine = stdout.find((l) => l.includes("work"));
		expect(workLine).toBeDefined();
		expect(workLine?.startsWith("* ")).toBe(true);
	});

	it("profile list reports an empty store", async () => {
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "list"]);
		});
		expect(stdout.some((l) => l.includes("No profiles defined"))).toBe(true);
	});

	it("profile view prints details and supports JSON output", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-p", "kimi-coding", "-m", "m1", "-t", "tok"]);
		});
		const plain = await capture(() => {
			hub.dispatchHubCommand(["profile", "view", "work"]);
		});
		expect(plain.stdout.some((l) => l.includes("Provider: kimi-coding"))).toBe(true);

		const json = await capture(() => {
			hub.dispatchHubCommand(["profile", "view", "work", "-j"]);
		});
		const parsed = JSON.parse(json.stdout.join("\n"));
		expect(parsed.name).toBe("work");
		expect(parsed.provider).toBe("kimi-coding");
	});

	it("profile view throws for an unknown profile", () => {
		expect(() => hub.dispatchHubCommand(["profile", "view", "ghost"])).toThrow("not found");
	});

	it("profile remove deletes the profile and its materialized dir", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-p", "kimi-coding", "-t", "tok-1234567890abcdef"]);
		});
		const dir = hub.profileDirFor("work");
		expect(fs.existsSync(dir)).toBe(true);

		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "remove", "work"]);
		});
		expect(stdout).toContain("Profile 'work' removed.");
		expect(hub.loadProfiles().profiles.work).toBeUndefined();
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("profile rename renames the materialized dir too", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "old", "-p", "kimi-coding", "-t", "tok-1234567890abcdef"]);
		});
		const { stdout } = await capture(() => {
			hub.dispatchHubCommand(["profile", "rename", "old", "new"]);
		});
		expect(stdout).toContain("Profile 'old' renamed to 'new'.");
		expect(fs.existsSync(hub.profileDirFor("new"))).toBe(true);
	});

	it("profile default --built-in is now an unknown option (built-in profile removed)", () => {
		expect(() => hub.dispatchHubCommand(["profile", "default", "--built-in"])).toThrow("unknown option '--built-in'");
	});

	it("profile default rejects an empty name pointing at unuse", () => {
		expect(() => hub.dispatchHubCommand(["profile", "default"])).toThrow("Use 'pipi unuse'");
	});

	it("profile default sets the default profile", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
			hub.dispatchHubCommand(["profile", "default", "work"]);
		});
		expect(hub.getDefaultProfileName()).toBe("work");
	});

	it("use sets and shows the default; unuse clears it", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
		});

		const empty = await capture(() => {
			hub.dispatchHubCommand(["use"]);
		});
		expect(empty.stdout.some((l) => l.includes("No default profile set"))).toBe(true);

		await capture(() => {
			hub.dispatchHubCommand(["use", "work"]);
		});
		expect(hub.getDefaultProfileName()).toBe("work");

		const shown = await capture(() => {
			hub.dispatchHubCommand(["use"]);
		});
		expect(shown.stdout.some((l) => l.includes("Default profile: 'work'"))).toBe(true);

		await capture(() => {
			hub.dispatchHubCommand(["unuse"]);
		});
		expect(hub.getDefaultProfileName()).toBeUndefined();
	});

	it("use throws for an unknown profile", () => {
		expect(() => hub.dispatchHubCommand(["use", "ghost"])).toThrow("not found");
	});

	it("use --built-in is now an unknown option (built-in profile removed)", () => {
		expect(() => hub.dispatchHubCommand(["use", "--built-in"])).toThrow("unknown option '--built-in'");
	});

	it("unknown subcommands throw", () => {
		expect(() => hub.dispatchHubCommand(["profile", "frobnicate"])).toThrow("unknown profile subcommand");
		expect(() => hub.dispatchHubCommand(["profile"])).toThrow("requires a subcommand");
		expect(() => hub.dispatchHubCommand(["completion", "zsh"])).toThrow("unknown hub command");
		expect(() => hub.dispatchHubCommand(["nope"])).toThrow("unknown hub command");
	});
});

describe("resolveLaunch", () => {
	beforeEach(async () => {
		setup();
		await load();
	});
	afterEach(teardown);

	it("resolves plain pi when no profile flag and no default", () => {
		expect(hub.resolveLaunch(["--version"])).toEqual({ kind: "plain", remainingArgs: ["--version"] });
	});

	it("strips --as <name> and returns a profile plan", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
		});
		expect(hub.resolveLaunch(["--as", "work", "--version"])).toEqual({
			kind: "profile",
			name: "work",
			remainingArgs: ["--version"],
		});
		expect(hub.resolveLaunch(["--as=work", "--version"])).toEqual({
			kind: "profile",
			name: "work",
			remainingArgs: ["--version"],
		});
	});

	it("throws for an unknown --as name", () => {
		expect(() => hub.resolveLaunch(["--as", "ghost"])).toThrow("Profile 'ghost' not found");
	});

	it("throws for a dangling --as flag", () => {
		expect(() => hub.resolveLaunch(["--as"])).toThrow("expects a profile name");
	});

	it("uses the default profile when no flag is given", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
			hub.dispatchHubCommand(["use", "work"]);
		});
		expect(hub.resolveLaunch(["--verbose"])).toEqual({
			kind: "profile",
			name: "work",
			remainingArgs: ["--verbose"],
		});
	});

	it("an explicit --as overrides the default", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "a", "-m", "m1"]);
			hub.dispatchHubCommand(["profile", "add", "b", "-m", "m2"]);
			hub.dispatchHubCommand(["use", "a"]);
		});
		expect(hub.resolveLaunch(["--as", "b"])).toEqual({
			kind: "profile",
			name: "b",
			remainingArgs: [],
		});
	});

	it("runs plain pi after unuse (no default key stored)", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
			hub.dispatchHubCommand(["use", "work"]);
			hub.dispatchHubCommand(["unuse"]);
		});
		expect(hub.loadProfiles().default).toBeUndefined();
		expect(hub.resolveLaunch(["--version"])).toEqual({ kind: "plain", remainingArgs: ["--version"] });
	});

	it("runs plain pi when the stored default is the legacy __builtin__ marker", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
		});
		fs.writeFileSync(
			process.env.PI_HUB_PROFILES_FILE as string,
			JSON.stringify({ profiles: { work: { models: ["m1"], model: "m1" } }, default: "__builtin__" }),
		);
		expect(hub.resolveLaunch(["--version"])).toEqual({ kind: "plain", remainingArgs: ["--version"] });
	});

	it("throws when the stored default profile no longer exists", async () => {
		await capture(() => {
			hub.dispatchHubCommand(["profile", "add", "work", "-m", "m1"]);
			hub.dispatchHubCommand(["use", "work"]);
		});
		// Simulate the profile being deleted without clearing the default
		fs.writeFileSync(process.env.PI_HUB_PROFILES_FILE as string, JSON.stringify({ profiles: {}, default: "work" }));
		expect(() => hub.resolveLaunch([])).toThrow("Profile 'work' not found");
	});
});
