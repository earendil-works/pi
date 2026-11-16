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

function writeSettings(agentDir: string, enabledModels: string[]): void {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", enabledModels }),
	);
}

describe("RPC diagnostics after session replacement", () => {
	// The runtime factory runs again on every new_session, but only the startup diagnostics were reported, so a
	// problem that first appeared on replacement went nowhere. Found while fixing #11264.
	it("writes a diagnostic that first appears on new_session to stderr once", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-rpc-replacement-diagnostics-"));
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
		writeSettings(agentDir, ["fake/fake-model"]);

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
		const responseCount = () => stdout.split('"command":"new_session"').length - 1;
		const newSession = (id: string) =>
			new Promise<void>((resolvePromise, reject) => {
				const expected = responseCount() + 1;
				const onData = (chunk: Buffer) => {
					stdout += chunk.toString();
					if (responseCount() >= expected) {
						child.stdout.off("data", onData);
						resolvePromise();
					}
				};
				child.stdout.on("data", onData);
				child.once("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
				child.stdin.write(`${JSON.stringify({ id, type: "new_session" })}\n`);
			});

		await newSession("1");
		writeSettings(agentDir, ["fake/fake-model", "github-copilot/missing-model"]);
		await newSession("2");
		await newSession("3");
		child.stdin.end();
		await exited;

		expect(stderr.match(/Warning: No models match pattern "github-copilot\/missing-model"/g)).toHaveLength(1);
		expect(stdout).not.toContain("No models match pattern");
	}, 60_000);
});
