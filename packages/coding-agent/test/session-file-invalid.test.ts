import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-file-invalid-")));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, stderr };
}

describe("--session invalid file handling", () => {
	it("prints a friendly error and preserves non-session file content", async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const sessionFile = join(tempRoot, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(sessionFile, originalContent);

		const result = await runCli(["--session", sessionFile, "-p", "hi"], projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Error: Session file is not a valid pi session: ${sessionFile}`);
		expect(result.stderr).not.toContain("SessionManager.open");
		expect(result.stderr).not.toContain("at ");
		expect(readFileSync(sessionFile, "utf8")).toBe(originalContent);
	});
});
