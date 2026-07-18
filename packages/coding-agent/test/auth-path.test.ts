import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { ENV_AGENT_DIR, ENV_AUTH_FILE, getAuthPath } from "../src/config.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";

const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalAuthFile = process.env[ENV_AUTH_FILE];
const tempDirs: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	if (originalAuthFile === undefined) delete process.env[ENV_AUTH_FILE];
	else process.env[ENV_AUTH_FILE] = originalAuthFile;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("getAuthPath", () => {
	test("defaults to auth.json in the configured agent directory", () => {
		process.env[ENV_AGENT_DIR] = "/tmp/pi-private-home";
		delete process.env[ENV_AUTH_FILE];
		expect(getAuthPath()).toBe(join("/tmp/pi-private-home", "auth.json"));
	});

	test("uses an auth-file override independently from the agent directory", () => {
		process.env[ENV_AGENT_DIR] = "/tmp/pi-private-home";
		process.env[ENV_AUTH_FILE] = "/tmp/pi-shared/auth.json";
		expect(getAuthPath()).toBe("/tmp/pi-shared/auth.json");
	});

	test("expands a tilde in the auth-file override", () => {
		process.env[ENV_AUTH_FILE] = "~/.pi/shared-auth.json";
		expect(getAuthPath()).toBe(join(homedir(), ".pi", "shared-auth.json"));
	});

	test("lists the branded auth-file variable in CLI help", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		printHelp();
		expect(log).toHaveBeenCalledWith(expect.stringContaining(ENV_AUTH_FILE));
	});

	test("does not migrate private legacy credentials into an explicit auth file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-auth-path-"));
		tempDirs.push(root);
		const agentDir = join(root, "private-agent");
		const authFile = join(root, "shared", "auth.json");
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_AUTH_FILE] = authFile;
		// The agent directory exists in real startup before migrations run.
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "oauth.json"),
			JSON.stringify({ anthropic: { access: "access", refresh: "refresh", expires: 1 } }),
		);

		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(existsSync(authFile)).toBe(false);
		expect(existsSync(join(agentDir, "oauth.json"))).toBe(true);
	});
});
