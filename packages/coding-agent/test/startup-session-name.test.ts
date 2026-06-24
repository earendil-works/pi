import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-startup-session-name-"));
	tempDirs.push(dir);
	return dir;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionFile: string;
}

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

function createSessionFile(projectDir: string, sessionFile: string): void {
	const timestamp = new Date().toISOString();
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "existing-session", timestamp, cwd: projectDir })}\n${JSON.stringify(
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					timestamp: Date.now(),
				},
			},
		)}\n`,
	);
}

function readSessionInfoNames(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type?: string; name?: string })
		.filter((entry) => entry.type === "session_info")
		.map((entry) => entry.name ?? "");
}

async function runCli(args: string[], dirs: CliDirs): Promise<CliResult> {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd: dirs.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: dirs.agentDir,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 10_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stderr });
		});
	});
}

function setup(): CliDirs {
	const tempRoot = createTempDir();
	const dirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionFile: join(tempRoot, "session.jsonl"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	createSessionFile(dirs.projectDir, dirs.sessionFile);
	return dirs;
}

describe("startup session name", () => {
	it("sets --name on the selected session before runtime model validation", async () => {
		const dirs = setup();
		const result = await runCli(
			["--session", dirs.sessionFile, "--name", "  CLI Named Session  ", "--model", "missing-model", "-p", "hi"],
			dirs,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(readSessionInfoNames(dirs.sessionFile)).toEqual(["CLI Named Session"]);
	});

	it("rejects empty --name values without appending session metadata", async () => {
		const dirs = setup();
		const result = await runCli(
			["--session", dirs.sessionFile, "--name", "   ", "--model", "missing-model", "-p", "hi"],
			dirs,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain("--name requires a non-empty value");
		expect(readSessionInfoNames(dirs.sessionFile)).toEqual([]);
	});
});
