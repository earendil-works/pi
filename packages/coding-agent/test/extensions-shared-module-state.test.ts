import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const fixtureSourceDir = path.join(__dirname, "fixtures", "extension-shared-module-state");
const runnerPath = path.join(fixtureSourceDir, "runner.ts");
const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

interface KittyAndKeybindingState {
	kittyActive: boolean;
	keyText: string;
	keybindingKeys: string[];
}

interface SharedModuleStateProbeResult {
	runtime: "Node" | "Bun";
	errors: Array<{ path: string; error: string }>;
	extensionCount: number;
	expectedKittyAndKeybindingState: KittyAndKeybindingState;
	kittyAndKeybindingStatesByExtension: Record<"ts" | "mjs" | "cjs", KittyAndKeybindingState[]>;
	kittySettersShareState: Record<"ts" | "mjs" | "cjs", boolean>;
	keybindingsShared: Record<"ts" | "mjs" | "cjs", boolean>;
	queuesShared: Record<"ts" | "mjs" | "cjs", boolean>;
}

describe("extension shared module state", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-shared-module-state-"));
		for (const extension of ["extension.ts", "extension.mjs", "extension.cjs"]) {
			fs.copyFileSync(path.join(fixtureSourceDir, extension), path.join(tempDir, extension));
		}

		// Place private Pi package copies next to the extensions. The loader must intercept
		// their imports and return host modules instead of resolving these copies.
		const privateModulesDir = path.join(fixtureSourceDir, "private-modules");
		const privateScopeDir = path.join(tempDir, "node_modules", "@earendil-works");
		fs.mkdirSync(privateScopeDir, { recursive: true });
		fs.cpSync(path.join(privateModulesDir, "pi-coding-agent"), path.join(privateScopeDir, "pi-coding-agent"), {
			recursive: true,
		});
		fs.cpSync(path.join(privateModulesDir, "pi-tui"), path.join(privateScopeDir, "pi-tui"), {
			recursive: true,
		});
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// Exercise the plain Node, tsx, and Bun resolver chains in isolated runtime processes.
	function runSharedModuleStateProbe(command: string, args: string[]): SharedModuleStateProbeResult {
		const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(result.error?.message || result.stderr || `Probe exited with status ${result.status}`);
		}
		return JSON.parse(result.stdout.trim()) as SharedModuleStateProbeResult;
	}

	function expectSharedHostModules(result: SharedModuleStateProbeResult, runtime: "Node" | "Bun"): void {
		// Report every shared-state failure from a probe instead of hiding queue or keybinding
		// failures behind the first Kitty state mismatch.
		expect.soft(result.runtime).toBe(runtime);
		expect.soft(result.errors).toEqual([]);
		expect.soft(result.extensionCount).toBe(3);
		for (const states of Object.values(result.kittyAndKeybindingStatesByExtension)) {
			expect.soft(states.length).toBeGreaterThan(0);
			for (const state of states) expect.soft(state).toEqual(result.expectedKittyAndKeybindingState);
		}
		expect.soft(result.kittySettersShareState).toEqual({ ts: true, mjs: true, cjs: true });
		expect.soft(result.keybindingsShared).toEqual({ ts: true, mjs: true, cjs: true });
		expect.soft(result.queuesShared).toEqual({ ts: true, mjs: true, cjs: true });
	}

	it("shares real host APIs with TS, ESM, and CommonJS extensions under plain Node", () => {
		// process.execPath is the Node executable running Vitest. Node 22.19+ executes this
		// erasable runner.ts directly, without tsx or another transform hook.
		const result = runSharedModuleStateProbe(process.execPath, [runnerPath, tempDir]);
		expectSharedHostModules(result, "Node");
	}, 30_000);

	it("shares real host APIs with TS, ESM, and CommonJS extensions under Node and tsx", () => {
		const result = runSharedModuleStateProbe(process.execPath, ["--import", "tsx", runnerPath, tempDir]);
		expectSharedHostModules(result, "Node");
	}, 30_000);

	it.skipIf(!bunAvailable)(
		"shares real host APIs with TS, ESM, and CommonJS extensions under Bun",
		() => {
			const result = runSharedModuleStateProbe("bun", [runnerPath, tempDir]);
			expectSharedHostModules(result, "Bun");
		},
		30_000,
	);
});
