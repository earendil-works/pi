import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = path.join(scriptDir, "src", "win32-console-mode.c");
const temporaryDir = mkdtempSync(path.join(tmpdir(), "pi-tui-win32-"));

const targets = [
	{
		arch: "x64",
		msvcArch: "x64",
		mingwTarget: "x86_64-w64-windows-gnu",
		prefixedCompilers: ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-clang"],
		envCompiler: "CC_X64",
	},
	{
		arch: "arm64",
		msvcArch: "arm64",
		mingwTarget: "aarch64-w64-windows-gnu",
		prefixedCompilers: ["aarch64-w64-mingw32-gcc", "aarch64-w64-mingw32-clang"],
		envCompiler: "CC_ARM64",
	},
];

function removeTemporaryDir() {
	rmSync(temporaryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

process.on("exit", removeTemporaryDir);
process.on("SIGINT", () => {
	removeTemporaryDir();
	process.exit(130);
});

function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error || result.error.code !== "ENOENT";
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
}

function quoteBatch(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

function msvcHostArch() {
	return process.arch === "arm64" ? "arm64" : "x64";
}

function findVisualStudioDevCmd() {
	const candidates = [];
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	if (programFilesX86) {
		const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
		if (existsSync(vswhere)) {
			const result = spawnSync(
				vswhere,
				[
					"-latest",
					"-products",
					"*",
					"-requires",
					"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
					"-property",
					"installationPath",
				],
				{ encoding: "utf8" },
			);
			for (const line of result.stdout.split(/\r?\n/)) {
				const installationPath = line.trim();
				if (installationPath) candidates.push(path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat"));
			}
		}
	}

	for (const base of [process.env.ProgramFiles, programFilesX86]) {
		if (!base) continue;
		for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
			candidates.push(path.join(base, "Microsoft Visual Studio", "2022", edition, "Common7", "Tools", "VsDevCmd.bat"));
		}
	}

	return candidates.find((candidate) => existsSync(candidate));
}

function canUseMsvc(vsDevCmd) {
	const probeDir = path.join(temporaryDir, "msvc-probe");
	mkdirSync(probeDir, { recursive: true });
	const batchFile = path.join(probeDir, "probe.cmd");
	writeFileSync(
		batchFile,
		[
			"@echo off",
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=x64 -host_arch=${msvcHostArch()} >nul`,
			"if errorlevel 1 exit /b %errorlevel%",
			"where cl.exe >nul 2>nul",
		].join("\r\n"),
	);
	const result = spawnSync("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: probeDir, stdio: "ignore" });
	return !result.error && result.status === 0;
}

function resolveMingwCompiler(target) {
	const envCompiler = process.env[target.envCompiler];
	if (envCompiler) return { command: envCompiler, useTargetFlag: false };
	if (process.env.CC) return { command: process.env.CC, useTargetFlag: true };
	for (const command of target.prefixedCompilers) {
		if (commandExists(command)) return { command, useTargetFlag: false };
	}
	if (commandExists("clang")) return { command: "clang", useTargetFlag: true };
	return undefined;
}

function installOutput(temporaryOutput, target) {
	const outputDir = path.join(scriptDir, "prebuilds", `win32-${target.arch}`);
	mkdirSync(outputDir, { recursive: true });
	const output = path.join(outputDir, "win32-console-mode.node");
	copyFileSync(temporaryOutput, output);
	chmodSync(output, 0o755);
	console.log(`Built ${path.relative(process.cwd(), output)}`);
}

function buildWithMsvc(target, vsDevCmd) {
	const buildDir = path.join(temporaryDir, `msvc-${target.arch}`);
	const temporaryOutput = path.join(buildDir, "win32-console-mode.node");
	mkdirSync(buildDir, { recursive: true });

	const batchFile = path.join(buildDir, "build.cmd");
	writeFileSync(
		batchFile,
		[
			"@echo off",
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=${target.msvcArch} -host_arch=${msvcHostArch()}`,
			"if errorlevel 1 exit /b %errorlevel%",
			[
				"cl",
				"/nologo",
				"/TC",
				"/std:c11",
				"/W4",
				"/O1",
				"/GS-",
				"/LD",
				`/Fe:${quoteBatch(temporaryOutput)}`,
				quoteBatch(sourceFile),
				"/link",
				"/NOENTRY",
				"/NODEFAULTLIB",
				"kernel32.lib",
				"/OPT:REF",
				"/OPT:ICF",
			].join(" "),
			"if errorlevel 1 exit /b %errorlevel%",
		].join("\r\n"),
	);

	run("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: buildDir });
	installOutput(temporaryOutput, target);
}

function buildWithMingw(target) {
	const compiler = resolveMingwCompiler(target);
	if (!compiler) {
		throw new Error(
			`No Windows cross-compiler found for ${target.arch}. Install Microsoft C++ Build Tools on Windows, or set ${target.envCompiler} to a MinGW-compatible compiler.`,
		);
	}

	const buildDir = path.join(temporaryDir, `mingw-${target.arch}`);
	const temporaryOutput = path.join(buildDir, "win32-console-mode.node");
	mkdirSync(buildDir, { recursive: true });

	const args = [
		...(compiler.useTargetFlag ? [`--target=${target.mingwTarget}`] : []),
		"-std=c11",
		"-Wall",
		"-Wextra",
		"-Oz",
		"-shared",
		"-nostdlib",
		"-Wl,--no-entry",
		"-Wl,--strip-all",
		sourceFile,
		"-lkernel32",
		"-o",
		temporaryOutput,
	];

	run(compiler.command, args, { cwd: buildDir });
	installOutput(temporaryOutput, target);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: npm --prefix packages/tui run build:native:win32

Builds win32-x64 and win32-arm64 native prebuilds.

Environment:
  PI_TUI_WIN32_TOOLCHAIN=msvc|mingw
  CC_X64=/path/to/x86_64-w64-mingw32-gcc
  CC_ARM64=/path/to/aarch64-w64-mingw32-gcc
  CC=/path/to/clang`);
	process.exit(0);
}

const requestedToolchain = process.env.PI_TUI_WIN32_TOOLCHAIN;
if (requestedToolchain && requestedToolchain !== "msvc" && requestedToolchain !== "mingw") {
	throw new Error("PI_TUI_WIN32_TOOLCHAIN must be either 'msvc' or 'mingw'");
}

const vsDevCmd = findVisualStudioDevCmd();
const hasMsvc = vsDevCmd ? canUseMsvc(vsDevCmd) : false;
const toolchain = requestedToolchain ?? (process.platform === "win32" && vsDevCmd ? "msvc" : "mingw");

if (toolchain === "msvc") {
	if (!vsDevCmd || !hasMsvc) {
		throw new Error("Microsoft C++ Build Tools not found. Install the Visual Studio C++ workload or set PI_TUI_WIN32_TOOLCHAIN=mingw.");
	}
	for (const target of targets) buildWithMsvc(target, vsDevCmd);
} else {
	for (const target of targets) buildWithMingw(target);
}
