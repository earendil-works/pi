import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { main } from "../src/main.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalPath: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	async function runPackageCommandDirectly(args: string[]): Promise<void> {
		expect(await handlePackageCommand(args)).toBe(true);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalPath = process.env.PATH;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = undefined;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not prompt or ask extensions for project trust during update", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fakeNpmPath = join(tempDir, "fake-project-npm.cjs");
		const recordPath = join(tempDir, "project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		let projectTrustCalled = false;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["update", "--extensions"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => {
								projectTrustCalled = true;
								return { trusted: "yes" };
							});
						},
					],
				}),
			).resolves.toBeUndefined();

			expect(projectTrustCalled).toBe(false);
			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses saved project trust during update", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const fakeNpmPath = join(tempDir, "fake-trusted-project-npm.cjs");
		const recordPath = join(tempDir, "trusted-project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(existsSync(recordPath)).toBe(true);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir]);

		const settingsPath = join(projectDir, ".pi", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, ".pi", stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("pi install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "pi --help" or "pi install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: pi install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("uses the update check version for forced self updates even when current", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		writeFileSync(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const fetchMock = vi.fn(async () => Response.json({ version: VERSION }));
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(globalPrefix);
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@${VERSION}`);
			expect(recordedArgs).not.toContain(PACKAGE_NAME);
			expect(recordedArgs).not.toContain(projectPrefix);
			expect(stdout).toContain(`Updated pi from ${VERSION} to ${VERSION}`);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("uses the current package name when the update check omits packageName", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const targetVersion = getNewerPatchVersion();
		const fetchMock = vi.fn(async () => Response.json({ version: targetVersion }));
		vi.stubGlobal("fetch", fetchMock);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledOnce();
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@${targetVersion}`);
			expect(recordedArgs).not.toContain(PACKAGE_NAME);
			expect(stdout).toContain(`Updated pi from ${VERSION} to ${targetVersion}`);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the active package name from the update check during self-update", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else {
	const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
	records.push(args);
	fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", `${activePackageName}@0.73.0`]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("prints a pnpm metadata hint when self-update fails", async () => {
		const globalRoot = join(tempDir, "pnpm", "global", "v11");
		const selfPackageDir = join(globalRoot, "node_modules", "@earendil-works", "pi-coding-agent");
		const fakeBinDir = join(tempDir, "bin");
		const fakePnpmPath = join(fakeBinDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(fakeBinDir, { recursive: true });
		writeFileSync(join(selfPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
		const fakePnpmScript =
			process.platform === "win32"
				? `@echo off\r\nif "%1"=="root" if "%2"=="-g" (echo ${globalRoot} & exit /b 0)\r\nexit /b 23\r\n`
				: `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${globalRoot.replaceAll("'", "'\\''")}'\n\texit 0\nfi\nexit 23\n`;
		writeFileSync(fakePnpmPath, fakePnpmScript);
		chmodSync(fakePnpmPath, 0o755);
		process.env.PATH = `${fakeBinDir}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`;
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(tempDir, "pnpm", "bin", "node"),
			configurable: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: getNewerPatchVersion() })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("Updated pi");
			expect(stderr).toContain("exited with code 23");
			expect(stderr).toContain("If pnpm reports missing package versions");
			expect(stderr).toContain("Run `pnpm store prune` and retry `pi update --self`.");
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails self-update when renamed npm package installation fails", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm-fail.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
if(args.includes("install")) process.exit(23);
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.PI_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME === "@new-scope/pi" ? "@newer-scope/pi" : "@new-scope/pi";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated pi`);
			expect(stderr).toContain("exited with code 23");
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([
				expect.arrayContaining(["uninstall", "-g", PACKAGE_NAME]),
				expect.arrayContaining(["install", "-g", `${activePackageName}@0.73.0`]),
			]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
