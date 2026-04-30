import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	ENV_AGENT_SESSION_DIR,
	ENV_CODING_AGENT_SESSION_DIR,
	expandHomePath,
	getEnvSessionDir,
	getSelfUpdateCommand,
	getUpdateInstruction,
	resolveConfiguredSessionDir,
} from "../src/config.js";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalSessionDirEnv = process.env[ENV_CODING_AGENT_SESSION_DIR];
const originalLegacySessionDirEnv = process.env[ENV_AGENT_SESSION_DIR];

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalSessionDirEnv === undefined) {
		delete process.env[ENV_CODING_AGENT_SESSION_DIR];
	} else {
		process.env[ENV_CODING_AGENT_SESSION_DIR] = originalSessionDirEnv;
	}
	if (originalLegacySessionDirEnv === undefined) {
		delete process.env[ENV_AGENT_SESSION_DIR];
	} else {
		process.env[ENV_AGENT_SESSION_DIR] = originalLegacySessionDirEnv;
	}
});

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@mariozechner+pi-coding-agent@0.67.68\\node_modules\\@mariozechner\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@mariozechner/pi-coding-agent")).toBe(
			"Run: pnpm install -g @mariozechner/pi-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@mariozechner/pi-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@mariozechner/pi-coding-agent")).toBe(
			"Update @mariozechner/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});
});

describe("session directory config", () => {
	test("expands tilde paths", () => {
		expect(expandHomePath("~")).toBe(homedir());
		expect(expandHomePath("~/sessions")).toBe(join(homedir(), "sessions"));
		expect(expandHomePath("./sessions")).toBe("./sessions");
	});

	test("reads session directory from environment", () => {
		process.env[ENV_CODING_AGENT_SESSION_DIR] = "~/pi-sessions";

		expect(getEnvSessionDir()).toBe(join(homedir(), "pi-sessions"));
	});

	test("supports legacy session directory environment alias", () => {
		delete process.env[ENV_CODING_AGENT_SESSION_DIR];
		process.env[ENV_AGENT_SESSION_DIR] = "/tmp/pi-agent-sessions";

		expect(getEnvSessionDir()).toBe("/tmp/pi-agent-sessions");
	});

	test("prefers primary environment variable over legacy alias", () => {
		process.env[ENV_CODING_AGENT_SESSION_DIR] = "/tmp/pi-coding-agent-sessions";
		process.env[ENV_AGENT_SESSION_DIR] = "/tmp/pi-agent-sessions";

		expect(getEnvSessionDir()).toBe("/tmp/pi-coding-agent-sessions");
	});

	test("resolves session directory precedence", () => {
		process.env[ENV_CODING_AGENT_SESSION_DIR] = "/env/sessions";

		expect(resolveConfiguredSessionDir("~/cli-sessions", "/settings/sessions")).toBe(join(homedir(), "cli-sessions"));
		expect(resolveConfiguredSessionDir(undefined, "/settings/sessions")).toBe("/env/sessions");
		delete process.env[ENV_CODING_AGENT_SESSION_DIR];
		expect(resolveConfiguredSessionDir(undefined, "/settings/sessions")).toBe("/settings/sessions");
		expect(resolveConfiguredSessionDir(undefined, undefined)).toBeUndefined();
	});
});
