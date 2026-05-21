#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packages = [
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = { force: false, outDir: undefined, skipBunInstall: false, skipCheck: false, skipInstall: false };
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) {
		return mkdtempSync(join(tmpdir(), "lyla-local-release-"));
	}

	const outDir = resolve(options.outDir);

	if (isInsidePath(outDir, repoRoot)) {
		throw new Error(`Output directory must be outside the repository: ${outDir}`);
	}

	if (existsSync(outDir)) {
		if (!options.force) {
			throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		}
		rmSync(outDir, { force: true, recursive: true });
	}

	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function copyBinaryAssets(targetDirectory) {
	const codingAgentDirectory = join(repoRoot, "packages", "coding-agent");
	const distDirectory = join(codingAgentDirectory, "dist");
	cpSync(join(codingAgentDirectory, "package.json"), join(targetDirectory, "package.json"));
	cpSync(join(codingAgentDirectory, "README.md"), join(targetDirectory, "README.md"));
	cpSync(join(codingAgentDirectory, "CHANGELOG.md"), join(targetDirectory, "CHANGELOG.md"));
	cpSync(join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"), join(targetDirectory, "photon_rs_bg.wasm"));
	cpSync(join(distDirectory, "modes", "interactive", "theme"), join(targetDirectory, "theme"), { recursive: true });
	cpSync(join(distDirectory, "modes", "interactive", "assets"), join(targetDirectory, "assets"), { recursive: true });
	cpSync(join(distDirectory, "core", "export-html"), join(targetDirectory, "export-html"), { recursive: true });
	cpSync(join(codingAgentDirectory, "docs"), join(targetDirectory, "docs"), { recursive: true });
	cpSync(join(codingAgentDirectory, "examples"), join(targetDirectory, "examples"), { recursive: true });
}

function copyWindowsConsoleModeHelper(targetDirectory, platform) {
	if (!platform.startsWith("windows-")) return;
	const win32Arch = platform === "windows-arm64" ? "win32-arm64" : "win32-x64";
	const relativeNativePath = join("native", "win32", "prebuilds", win32Arch);
	mkdirSync(join(targetDirectory, relativeNativePath), { recursive: true });
	cpSync(
		join(repoRoot, "packages", "tui", "native", "win32", "prebuilds", win32Arch, "win32-console-mode.node"),
		join(targetDirectory, relativeNativePath, "win32-console-mode.node"),
	);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	if (!commandExists("bun")) {
		throw new Error("Bun is required for the local binary release build.");
	}
	const platform = currentBinaryPlatform();
	mkdirSync(targetDirectory, { recursive: true });
	const executableName = platform.startsWith("windows-") ? "lyla.exe" : "lyla";
	const executablePath = join(targetDirectory, executableName);
	const target = `bun-${platform}`;
	run("bun", ["build", "--compile", `--target=${target}`, join(repoRoot, "packages", "coding-agent", "dist", "bun", "cli.js"), "--outfile", executablePath]);
	copyBinaryAssets(targetDirectory);
	copyWindowsConsoleModeHelper(targetDirectory, platform);
	if (platform.startsWith("windows-")) {
		run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${join(targetDirectory, "*").replaceAll("'", "''")}' -DestinationPath '${join(archiveDirectory, `lyla-${platform}.zip`).replaceAll("'", "''")}' -Force`]);
	} else {
		run("tar", ["-czf", join(archiveDirectory, `lyla-${platform}.tar.gz`), "-C", targetDirectory, "."]);
	}
	return platform;
}

function createLylaShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "lyla.cmd"))) {
			writeFileSync(join(installDirectory, "lyla.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\lyla.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "lyla.ps1"), '& "$PSScriptRoot/node_modules/.bin/lyla.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "lyla.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\lyla.exe" %*\r\n');
		writeFileSync(join(installDirectory, "lyla.ps1"), '& "$PSScriptRoot/node_modules/.bin/lyla.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "lyla"), join(installDirectory, "lyla"));
}

function packPackage(pkg, tarballDirectory) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}

	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	const packed = JSON.parse(output)[0];
	return join(tarballDirectory, packed.filename);
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);

if (rootPackageJson.name !== "lyla-monorepo") {
	throw new Error("Run this script from the repository root");
}

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");
const binaryDirectory = join(outDir, "bun");
mkdirSync(tarballDirectory, { recursive: true });

if (!options.skipCheck) {
	run("npm", ["run", "check"], { cwd: repoRoot });
}

for (const pkg of packages) {
	run("npm", ["run", "clean"], { cwd: pkg.directory });
	run("npm", ["run", "build"], { cwd: pkg.directory });
}

const tarballs = new Map();
for (const pkg of packages) {
	const tarball = packPackage(pkg, tarballDirectory);
	tarballs.set(pkg.name, tarball);
}

let binaryPlatform;
if (!options.skipInstall) {
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);

	mkdirSync(nodeInstallDirectory, { recursive: true });
	const dependencies = Object.fromEntries(
		packages.map((pkg) => [pkg.name, fileSpecifier(nodeInstallDirectory, tarballs.get(pkg.name))]),
	);
	const installPackageJson = `${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`;
	writeFileSync(join(nodeInstallDirectory, "package.json"), installPackageJson);

	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: nodeInstallDirectory });
	createLylaShim(nodeInstallDirectory);

	if (!options.skipBunInstall) {
		if (!commandExists("bun")) {
			throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
		}
		mkdirSync(bunInstallDirectory, { recursive: true });
		const bunDependencies = Object.fromEntries(
			packages.map((pkg) => [pkg.name, fileSpecifier(bunInstallDirectory, tarballs.get(pkg.name))]),
		);
		writeFileSync(join(bunInstallDirectory, "package.json"), `${JSON.stringify({ private: true, dependencies: bunDependencies, overrides: bunDependencies }, undefined, "\t")}\n`);
		run("bun", ["install", "--production", "--ignore-scripts"], { cwd: bunInstallDirectory });
		createLylaShim(bunInstallDirectory);
	}
}

console.log("\nLocal release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nTarballs:");
for (const tarball of tarballs.values()) {
	console.log(`  ${tarball}`);
}

if (!options.skipInstall) {
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	console.log(`  ${join(outDir, `lyla-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "lyla.exe" : "lyla")} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "lyla.cmd" : "lyla")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "lyla.cmd" : "lyla")} --help`);
	}
}
