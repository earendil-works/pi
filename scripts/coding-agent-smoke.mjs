import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const codingAgentName = "@earendil-works/pi-coding-agent";
const developmentPackages = new Set(["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`));

function checkInstalledPackages(nodeModules, seen = new Set()) {
	if (!existsSync(nodeModules)) return;
	const directories = readdirSync(nodeModules)
		.filter((name) => !name.startsWith("."))
		.flatMap((name) => name.startsWith("@")
			? readdirSync(join(nodeModules, name)).map((child) => join(nodeModules, name, child))
			: [join(nodeModules, name)]);
	for (const directory of directories) {
		if (!existsSync(join(directory, "package.json"))) continue;
		const path = realpathSync(directory);
		if (seen.has(path)) continue;
		seen.add(path);
		const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
		if (developmentPackages.has(manifest.name)) throw new Error(`${manifest.name} must not be installed: ${path}`);
		checkInstalledPackages(join(path, "node_modules"), seen);
	}
}

export function smokeTestCodingAgent(directory, runtime = process.execPath) {
	checkInstalledPackages(join(directory, "node_modules"));
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const path of ["dist/client", "dist/experimental", "dist/cli/experimental", "dist/bundle/client.js", "dist/bundle/coordinator.js"]) {
		if (existsSync(join(packageDir, path))) throw new Error(`Published package contains development-only code: ${path}`);
	}
	const home = mkdtempSync(join(tmpdir(), "pi-coding-agent-smoke-home-"));
	const entry = join(directory, "coding-agent-smoke.mjs");
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
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
for (const name of ["pi-client", "pi-protocol", "pi-server"]) {
  assert.throws(() => import.meta.resolve("@earendil-works/" + name), /Cannot find|cannot find/, name + " must not be installed");
}
for (const subpath of ["/client", "/experimental/plugin"]) {
  assert.throws(() => import.meta.resolve("${codingAgentName}" + subpath), /not exported|not defined|Cannot find|cannot find/);
}
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
	}
	console.log(`Coding-agent policy smoke tests passed (${runtime}).`);
}
