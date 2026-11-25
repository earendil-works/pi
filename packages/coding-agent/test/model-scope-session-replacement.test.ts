import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Start RPC mode, replace the session once, and return everything the process wrote to stderr. */
async function runNewSessionOverRpc(agentDir: string, projectDir: string): Promise<string> {
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
			if (stdout.includes('"command":"new_session"')) resolvePromise();
		});
		child.on("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
		child.stdin.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
	});
	child.stdin.end();
	await exited;
	return stderr;
}

describe("model scope warnings on session replacement", () => {
	// #11264: the runtime factory runs again on /new, /resume and /fork. It printed the model scope warnings
	// with console.warn, which drew over the interactive TUI. They are now startup diagnostics, reported once.
	it("reports unmatched enabledModels patterns once at startup, not again on new_session", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-model-scope-replacement-"));
		tempDirs.push(tempRoot);
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
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
			JSON.stringify({
				defaultProvider: "fake",
				defaultModel: "fake-model",
				enabledModels: ["fake/fake-model", "github-copilot/missing-model"],
			}),
		);

		const stderr = await runNewSessionOverRpc(agentDir, projectDir);

		expect(stderr.match(/No models match pattern "github-copilot\/missing-model"/g)).toHaveLength(1);
	}, 60_000);
});
