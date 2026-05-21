import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalLylaPackageDir = process.env.LYLA_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
const testUnlessWindows = process.platform === "win32" ? test.skip : test;
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalLylaPackageDir === undefined) {
		delete process.env.LYLA_PACKAGE_DIR;
	} else {
		process.env.LYLA_PACKAGE_DIR = originalLylaPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "lyla-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.LYLA_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "lyla-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.LYLA_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "lyla-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.LYLA_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "lyla-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.LYLA_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@lyla/coding-agent")).toBe(
			"Run: pnpm install -g --ignore-scripts @lyla/coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@lyla/coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@lyla/coding-agent")).toBe(
			"Update @lyla/coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "@lyla/coding-agent"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts @lyla/coding-agent`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "@new-scope/pi"],
			display: `npm --prefix ${prefix} uninstall -g @lyla/coding-agent && npm --prefix ${prefix} install -g --ignore-scripts @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@lyla/coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @lyla/coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g --ignore-scripts @new-scope/pi`,
				},
			],
		});
	});

	testUnlessWindows("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "@lyla/coding-agent"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts @lyla/coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "--ignore-scripts", "@lyla/coding-agent"]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@lyla/coding-agent");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g --ignore-scripts @lyla/coding-agent`);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		process.env.LYLA_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@lyla/coding-agent")).toBe(
			"Run: npm install -g --ignore-scripts @lyla/coding-agent",
		);
	});

	testUnlessWindows("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "@lyla/coding-agent"],
			display: "bun install -g --ignore-scripts @lyla/coding-agent",
		});
	});

	testUnlessWindows("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "@new-scope/pi"],
			display: "pnpm remove -g @lyla/coding-agent && pnpm install -g --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@lyla/coding-agent"],
					display: "pnpm remove -g @lyla/coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "--ignore-scripts", "@new-scope/pi"],
					display: "pnpm install -g --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	testUnlessWindows("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@lyla/coding-agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@earendil-works", "pi-coding-agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@earendil-works",
			"pi-coding-agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.LYLA_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", packageName],
			display: `pnpm install -g --ignore-scripts ${packageName}`,
		});
	});

	testUnlessWindows("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
			display: "yarn global remove @lyla/coding-agent && yarn global add --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@lyla/coding-agent"],
					display: "yarn global remove @lyla/coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
					display: "yarn global add --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	testUnlessWindows("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@lyla/coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "@new-scope/pi"],
			display: "bun uninstall -g @lyla/coding-agent && bun install -g --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@lyla/coding-agent"],
					display: "bun uninstall -g @lyla/coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "--ignore-scripts", "@new-scope/pi"],
					display: "bun install -g --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	testUnlessWindows("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@lyla/coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@lyla/coding-agent")).toContain("the install path is not writable");
	});
});
