// Builds pi-job.exe for win32-x64 and win32-arm64 into prebuilds/. Mirrors packages/tui/native/win32/build.mjs,
// which builds a DLL instead of an executable; both are self-contained so each ships in its own npm package.
// zig cc is the default when available: it cross-compiles both architectures from any OS and links
// deterministically, so a rebuild of the committed prebuilds from the same source gives identical bytes.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = path.join(scriptDir, "src", "pi-job.c");
const outputName = "pi-job.exe";
const temporaryDir = mkdtempSync(path.join(tmpdir(), "pi-job-win32-"));

const targets = [
	{
		arch: "x64",
		msvcArch: "x64",
		mingwTarget: "x86_64-w64-windows-gnu",
		zigTarget: "x86_64-windows-gnu",
		prefixedCompilers: ["x86_64-w64-mingw32-clang", "x86_64-w64-mingw32-gcc"],
		envCompiler: "CC_X64",
	},
	{
		arch: "arm64",
		msvcArch: "arm64",
		mingwTarget: "aarch64-w64-windows-gnu",
		zigTarget: "aarch64-windows-gnu",
		prefixedCompilers: ["aarch64-w64-mingw32-clang", "aarch64-w64-mingw32-gcc"],
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

function resolveZig() {
	const zig = process.env.ZIG ?? "zig";
	const result = spawnSync(zig, ["env"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	// `zig env` prints ZON with escaped strings: `.lib_dir = "C:\\zig\\lib",`.
	const match = /\.lib_dir = "((?:[^"\\]|\\.)*)"/.exec(result.stdout);
	if (!match) return undefined;
	return { command: zig, libDir: match[1].replace(/\\(.)/g, "$1") };
}

// Flags shared by the MinGW and zig toolchains: no C runtime, entry point `entry`, console subsystem.
const gnuFlags = [
	"-std=c11",
	"-Wall",
	"-Wextra",
	"-Oz",
	"-fno-builtin",
	"-nostdlib",
	"-municode",
	"-Wl,--entry=entry",
	"-Wl,--subsystem,console",
	"-Wl,--strip-all",
];

function installOutput(temporaryOutput, target) {
	const outputDir = path.join(scriptDir, "prebuilds", `win32-${target.arch}`);
	mkdirSync(outputDir, { recursive: true });
	const output = path.join(outputDir, outputName);
	copyFileSync(temporaryOutput, output);
	chmodSync(output, 0o755);
	console.log(`Built ${path.relative(process.cwd(), output)}`);
}

function buildWithMsvc(target, vsDevCmd) {
	const buildDir = path.join(temporaryDir, `msvc-${target.arch}`);
	const temporaryOutput = path.join(buildDir, outputName);
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
				`/Fe:${quoteBatch(temporaryOutput)}`,
				quoteBatch(sourceFile),
				"/link",
				"/ENTRY:entry",
				"/SUBSYSTEM:CONSOLE",
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
	const temporaryOutput = path.join(buildDir, outputName);
	mkdirSync(buildDir, { recursive: true });

	const args = [
		...(compiler.useTargetFlag ? [`--target=${target.mingwTarget}`] : []),
		...gnuFlags,
		sourceFile,
		"-lkernel32",
		"-o",
		temporaryOutput,
	];

	run(compiler.command, args, { cwd: buildDir });
	installOutput(temporaryOutput, target);
}

function buildWithZig(target, zig) {
	const buildDir = path.join(temporaryDir, `zig-${target.arch}`);
	const temporaryOutput = path.join(buildDir, outputName);
	mkdirSync(buildDir, { recursive: true });

	// -nostdlib also drops zig's libc include paths; the Windows headers it bundles are added back explicitly.
	const windowsHeaders = path.join(zig.libDir, "libc", "include", "any-windows-any");
	const args = [
		"cc",
		`--target=${target.zigTarget}`,
		"-isystem",
		windowsHeaders,
		...gnuFlags,
		sourceFile,
		"-lkernel32",
		"-o",
		temporaryOutput,
	];

	run(zig.command, args, { cwd: buildDir });
	installOutput(temporaryOutput, target);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: npm --prefix packages/coding-agent run build:native:win32

Builds win32-x64 and win32-arm64 pi-job.exe prebuilds.

Toolchains, in order of preference: zig (zig cc), msvc (on Windows), mingw.

Environment:
  PI_WIN32_TOOLCHAIN=zig|msvc|mingw
  ZIG=/path/to/zig
  CC_X64=/path/to/x86_64-w64-mingw32-clang
  CC_ARM64=/path/to/aarch64-w64-mingw32-clang
  CC=/path/to/clang`);
	process.exit(0);
}

const requestedToolchain = process.env.PI_WIN32_TOOLCHAIN;
if (requestedToolchain && !["zig", "msvc", "mingw"].includes(requestedToolchain)) {
	throw new Error("PI_WIN32_TOOLCHAIN must be 'zig', 'msvc' or 'mingw'");
}

const zig = requestedToolchain === undefined || requestedToolchain === "zig" ? resolveZig() : undefined;
const vsDevCmd = findVisualStudioDevCmd();
const toolchain = requestedToolchain ?? (zig ? "zig" : process.platform === "win32" && vsDevCmd ? "msvc" : "mingw");

if (toolchain === "zig") {
	if (!zig) throw new Error("zig not found. Install zig (https://ziglang.org/download/) or set ZIG to its path.");
	for (const target of targets) buildWithZig(target, zig);
} else if (toolchain === "msvc") {
	if (!vsDevCmd || !canUseMsvc(vsDevCmd)) {
		throw new Error("Microsoft C++ Build Tools not found. Install the Visual Studio C++ workload or set PI_WIN32_TOOLCHAIN=mingw.");
	}
	for (const target of targets) buildWithMsvc(target, vsDevCmd);
} else {
	for (const target of targets) buildWithMingw(target);
}
