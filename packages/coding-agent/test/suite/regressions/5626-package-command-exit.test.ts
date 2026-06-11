import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

const tempDirs: string[] = [];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const tsxPath = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-5626-package-exit-"));
	tempDirs.push(dir);
	return dir;
}

function runCli(args: string[], options: { cwd: string; agentDir: string; timeoutMs?: number }): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[tsxPath, "--tsconfig", join(repoRoot, "tsconfig.json"), cliPath, ...args],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: options.agentDir,
					PI_SKIP_VERSION_CHECK: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`pi child did not exit. stdout:\n${stdout}\nstderr:\n${stderr}`));
		}, options.timeoutMs ?? 5000);

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("package command process exit (#5626)", () => {
	test("package commands exit even when project-trust extensions leave active handles", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		const extensionPath = join(tempDir, "leaky-extension.ts");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			extensionPath,
			`export default function () {
	setInterval(() => {}, 60_000);
}
`,
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extensionPath] }));

		const result = await runCli(["list"], { cwd: projectDir, agentDir });

		expect(result.code).toBe(0);
		expect(result.signal).toBeNull();
		expect(result.stdout).toContain("No packages installed.");
		expect(result.stderr).toBe("");
	});

	test("package commands preserve non-zero exit codes", async () => {
		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		const result = await runCli(["install"], { cwd: projectDir, agentDir });

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain("Missing install source.");
	});
});
