import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Dirs {
	agentDir: string;
	projectDir: string;
	probeFile: string;
	extensionFile: string;
}

function setup(): Dirs {
	const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-project-trust-saved-")));
	tempDirs.push(tempRoot);
	const dirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		probeFile: join(tempRoot, "probe.json"),
		extensionFile: join(tempRoot, "probe-extension.ts"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	// AGENTS.md alone is not a trust-requiring project resource.
	writeFileSync(join(dirs.projectDir, "AGENTS.md"), "# untrusted\n");
	writeFileSync(
		dirs.extensionFile,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerProvider("trust-probe", {
		baseUrl: "https://trust-probe.invalid/v1",
		apiKey: "trust-probe-key",
		api: "openai-completions",
		models: [{
			id: "trust-probe-model",
			name: "trust-probe-model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10000,
			maxTokens: 1000,
		}],
	});
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(${JSON.stringify(dirs.probeFile)}, JSON.stringify({ trusted: ctx.isProjectTrusted() }));
		process.exit(0);
	});
}
`,
	);
	return dirs;
}

async function probeProjectTrust(dirs: Dirs): Promise<boolean> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			sourceResolverUrl,
			cliPath,
			"--no-session",
			"-e",
			dirs.extensionFile,
			"--provider",
			"trust-probe",
			"--model",
			"trust-probe-model",
			"-p",
			"hi",
		],
		{
			cwd: dirs.projectDir,
			env: { ...process.env, [ENV_AGENT_DIR]: dirs.agentDir, PI_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolvePromise(exitCode);
		});
	});
	expect(code, stderr).toBe(0);
	return (JSON.parse(readFileSync(dirs.probeFile, "utf8")) as { trusted: boolean }).trusted;
}

// Regression tests for https://github.com/earendil-works/pi/issues/10947
describe("saved project trust for projects without trust-requiring resources", () => {
	it("reports a saved Do not trust decision to extensions", async () => {
		const dirs = setup();
		new ProjectTrustStore(dirs.agentDir).set(dirs.projectDir, false);

		expect(await probeProjectTrust(dirs)).toBe(false);
	}, 30_000);

	it("auto-trusts when no decision is saved", async () => {
		const dirs = setup();

		expect(await probeProjectTrust(dirs)).toBe(true);
	}, 30_000);

	it("resolveProjectTrusted honors the saved decision before auto-trust", async () => {
		const dirs = setup();
		const trustStore = new ProjectTrustStore(dirs.agentDir);
		const resolve = () =>
			resolveProjectTrusted({
				cwd: dirs.projectDir,
				trustStore,
				projectTrustContext: createProjectTrustContext({
					cwd: dirs.projectDir,
					mode: "print",
					settingsManager: SettingsManager.inMemory(),
					hasUI: false,
				}),
			});

		expect(await resolve()).toBe(true);
		trustStore.set(dirs.projectDir, false);
		expect(await resolve()).toBe(false);
		trustStore.set(dirs.projectDir, true);
		expect(await resolve()).toBe(true);
	});
});
