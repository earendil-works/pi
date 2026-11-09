import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codingAgentName = "@earendil-works/pi-coding-agent";

export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	const entry = join(directory, "coding-agent-smoke.mjs");
	const searchRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-search-"));
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		writeFileSync(join(searchRoot, "source.ts"), "before\nneedle\nafter\n");
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime, createGrepTool, createFindTool } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
process.env.PATH = "";
const grep = await createGrepTool(${JSON.stringify(searchRoot)}).execute("native-grep", { pattern: "need(?=le)", context: 0 });
assert.equal(grep.content[0].text, "source.ts:2: needle");
const find = await createFindTool(${JSON.stringify(searchRoot)}).execute("native-find", { pattern: "*.ts" });
assert.equal(find.content[0].text, "source.ts");
`);
		execFileSync(runtime, [entry], { cwd: directory, env, stdio: ["inherit", "pipe", "pipe"], timeout: 30_000 });
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = execFileSync(runtime, [join(packageDir, cli), "--version"], {
				cwd: directory,
				encoding: "utf8",
				env,
				stdio: ["inherit", "pipe", "pipe"],
				timeout: 30_000,
			});
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(searchRoot, { recursive: true, force: true });
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
