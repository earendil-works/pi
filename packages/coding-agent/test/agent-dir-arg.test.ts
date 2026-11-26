import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentDirArg } from "../src/cli/agent-dir-arg.ts";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const loadOrderEntryPath = resolve(__dirname, "fixtures/agent-dir-load-order/entry.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const originalAgentDir = process.env[ENV_AGENT_DIR];
const tempDirs: string[] = [];

beforeEach(() => {
	delete process.env[ENV_AGENT_DIR];
});

afterEach(() => {
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Runs a script with Node from `cwd`, without the agent and session dir variables of the test process. */
async function runNode(scriptPath: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
	delete env[ENV_AGENT_DIR];
	delete env[ENV_SESSION_DIR];
	const child = spawn(process.execPath, ["--import", sourceResolverUrl, scriptPath, ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	await new Promise<void>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", () => resolvePromise());
	});
	return { stdout, stderr };
}

function createTempDir(): string {
	// Real path: the child's process.cwd() resolves symlinks such as macOS's /var -> /private/var.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-agent-dir-arg-")));
	tempDirs.push(dir);
	return dir;
}

describe("applyAgentDirArg", () => {
	it("returns the arguments unchanged and leaves the variable alone without --agent-dir", () => {
		expect(applyAgentDirArg(["--session", "abc"])).toEqual({
			kind: "ok",
			args: ["--session", "abc"],
			agentDir: undefined,
		});
		expect(process.env[ENV_AGENT_DIR]).toBeUndefined();
	});

	it("takes the flag out in any position, so subcommands still come first", () => {
		expect(applyAgentDirArg(["--agent-dir", "/tmp/agent", "install", "npm:foo"])).toEqual({
			kind: "ok",
			args: ["install", "npm:foo"],
			agentDir: "/tmp/agent",
		});
		expect(applyAgentDirArg(["--session", "abc", "--agent-dir", "/tmp/agent"])).toEqual({
			kind: "ok",
			args: ["--session", "abc"],
			agentDir: "/tmp/agent",
		});
	});

	it("sets the variable to the last --agent-dir", () => {
		applyAgentDirArg(["--agent-dir", "/a", "--agent-dir", "/b"]);

		expect(process.env[ENV_AGENT_DIR]).toBe(resolve("/b"));
	});

	it("sets an absolute path, so a resume command does not depend on the directory it runs in", () => {
		applyAgentDirArg(["--agent-dir", "relative/agent"]);
		expect(process.env[ENV_AGENT_DIR]).toBe(resolve("relative/agent"));

		applyAgentDirArg(["--agent-dir", "~/custom-agent"]);
		expect(process.env[ENV_AGENT_DIR]).toBe(join(homedir(), "custom-agent"));
	});

	it("leaves arguments after -- as messages", () => {
		expect(applyAgentDirArg(["-p", "--", "--agent-dir", "/a"])).toEqual({
			kind: "ok",
			args: ["-p", "--", "--agent-dir", "/a"],
			agentDir: undefined,
		});
		expect(process.env[ENV_AGENT_DIR]).toBeUndefined();
	});

	it("reports a missing directory", () => {
		expect(applyAgentDirArg(["--agent-dir"])).toEqual({
			kind: "error",
			message: "--agent-dir requires a directory",
		});
	});
});

describe("--agent-dir at startup", () => {
	it("is set before modules that read the agent dir when they load", async () => {
		const dir = createTempDir();

		const { stdout } = await runNode(loadOrderEntryPath, ["--agent-dir", "agent"], dir);

		expect(stdout).toBe(join(dir, "agent"));
	}, 60_000);

	it("makes the CLI read models.json from that directory", async () => {
		const dir = createTempDir();
		mkdirSync(join(dir, "agent"));
		writeFileSync(
			join(dir, "agent", "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test",
						models: [{ id: "agent-dir-model" }],
					},
				},
			}),
		);

		const { stdout, stderr } = await runNode(cliPath, ["--list-models", "agent-dir", "--agent-dir", "agent"], dir);

		expect(stderr).toBe("");
		expect(stdout).toContain("agent-dir-model");
	}, 60_000);
});
