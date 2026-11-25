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

/** Runs the CLI with an agent dir whose models.json has a string contextWindow, and returns its output. */
async function runWithInvalidModelsJson(args: string[], input = ""): Promise<{ stdout: string; stderr: string }> {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-models-json-error-"));
	tempDirs.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					apiKey: "test",
					models: [{ id: "local-model", contextWindow: "32000" }],
				},
			},
		}),
	);

	const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
		cwd: projectDir,
		env: { ...process.env, [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<void>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", () => resolvePromise());
	});
	child.stdin.end(input);
	await exited;
	return { stdout, stderr };
}

function countOccurrences(text: string, search: string): number {
	return text.split(search).length - 1;
}

// Regression tests for https://github.com/earendil-works/pi/issues/12522: only interactive mode and --list-models reported models.json errors, so
// print, JSON and RPC modes failed with "Model not found" or "No API key found" and never named the cause.
describe("models.json error", () => {
	it("is written to stderr once in print mode", async () => {
		const { stderr } = await runWithInvalidModelsJson(["-p", "--model", "local/local-model", "hi"]);

		expect(countOccurrences(stderr, "Warning: models.json error:")).toBe(1);
		expect(countOccurrences(stderr, "providers.local.models.0.contextWindow")).toBe(1);
	}, 60_000);

	it("is written to stderr once in RPC mode", async () => {
		const { stdout, stderr } = await runWithInvalidModelsJson(
			["--mode", "rpc", "--no-session"],
			`${JSON.stringify({ id: "1", type: "get_state" })}\n`,
		);

		expect(countOccurrences(stderr, "Warning: models.json error:")).toBe(1);
		expect(stdout).not.toContain("models.json error");
	}, 60_000);

	it("is written to stderr once by --list-models", async () => {
		const { stderr } = await runWithInvalidModelsJson(["--list-models"]);

		expect(countOccurrences(stderr, "Warning: models.json error:")).toBe(1);
		expect(countOccurrences(stderr, "contextWindow")).toBe(1);
	}, 60_000);
});
