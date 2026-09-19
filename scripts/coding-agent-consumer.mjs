#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const codingAgentName = "@earendil-works/pi-coding-agent";
const developmentPackages = new Set(["pi-client", "pi-protocol", "pi-server"].map((name) => `@earendil-works/${name}`));

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		timeout: 300_000,
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
	}
	return result.stdout;
}

export function packReleasePackages(packages, tarballDirectory) {
	mkdirSync(tarballDirectory, { recursive: true });
	const tarballs = new Map();
	for (const pkg of packages) {
		const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (manifest.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], { cwd: pkg.directory });
		// npm <11.6 returns an array; newer npm can return an object keyed by package name.
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
		tarballs.set(pkg.name, join(tarballDirectory, packed.filename));
	}
	return tarballs;
}

export function installCodingAgentConsumer(directory, tarballs, packageManager = "npm") {
	mkdirSync(directory, { recursive: true });
	const overrides = Object.fromEntries([...tarballs].map(([name, path]) => [
		name, `file:./${relative(directory, path).replaceAll("\\", "/")}`,
	]));
	if (!overrides[codingAgentName]) throw new Error("Missing coding-agent tarball");
	// Only coding-agent is a direct dependency. Overrides select local artifacts
	// for declared transitive dependencies without installing undeclared packages.
	const manifest = {
		private: true,
		dependencies: { [codingAgentName]: overrides[codingAgentName] },
		overrides,
	};
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	const installArgs = packageManager === "bun" ? ["--production"] : ["--omit=dev", "--no-audit", "--no-fund"];
	run(packageManager, ["install", "--ignore-scripts", ...installArgs], { cwd: directory });
}

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

export function smokeTestCodingAgentConsumer(directory, runtime = process.execPath) {
	checkInstalledPackages(join(directory, "node_modules"));
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	for (const path of ["dist/client", "dist/experimental", "dist/cli/experimental", "dist/bundle/client.js", "dist/bundle/coordinator.js"]) {
		if (existsSync(join(packageDir, path))) throw new Error(`Published package contains development-only code: ${path}`);
	}
	const home = mkdtempSync(join(directory, "smoke-home-"));
	const entry = join(directory, "smoke-sdk.mjs");
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
		run(runtime, [entry], { cwd: directory, env, timeout: 30_000 });
		for (const cli of new Set([manifest.bin.pi, "dist/cli.js"])) {
			const output = run(runtime, [join(packageDir, cli), "--version"], { cwd: directory, env, timeout: 30_000 });
			if (output.trim() !== manifest.version) throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent SDK and CLI consumer smoke tests passed (${runtime}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("Usage: node scripts/coding-agent-consumer.mjs");
	const root = mkdtempSync(join(tmpdir(), "pi-package-consumer-"));
	try {
		const tarballs = packReleasePackages(getPublicWorkspacePackages(), join(root, "tarballs"));
		const directory = join(root, "consumer");
		installCodingAgentConsumer(directory, tarballs);
		smokeTestCodingAgentConsumer(directory);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
