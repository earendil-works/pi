import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A saved session whose last model, gone/missing-model, no longer exists. */
function createSessionWithMissingModel(projectDir: string, sessionDir: string): string {
	const sessionManager = SessionManager.create(projectDir, sessionDir);
	sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "gone",
		model: "missing-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("session was not persisted");
	return sessionFile;
}

describe("model fallback message", () => {
	// Found while fixing #11264: "Could not restore model" was shown only at interactive startup. A /resume into
	// a session whose model is gone fell back to another model silently, and other modes never showed it.
	it("is written to stderr in RPC mode when switch_session falls back to another model", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-model-fallback-"));
		tempDirs.push(tempRoot);
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fake: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test",
						models: [{ id: "fake-model" }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model" }),
		);
		const sessionFile = createSessionWithMissingModel(projectDir, sessionDir);

		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "--mode", "rpc", "--no-session"], {
			cwd: projectDir,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exited = new Promise<void>((resolvePromise, reject) => {
			child.on("error", reject);
			child.on("close", () => resolvePromise());
		});
		await new Promise<void>((resolvePromise, reject) => {
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
				if (stdout.includes('"command":"switch_session"')) resolvePromise();
			});
			child.on("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
			child.stdin.write(`${JSON.stringify({ id: "1", type: "switch_session", sessionPath: sessionFile })}\n`);
		});
		child.stdin.end();
		await exited;

		expect(stderr).toContain("Warning: Could not restore model gone/missing-model. Using fake/fake-model");
		expect(stdout).not.toContain("Could not restore model");
	}, 60_000);
});
