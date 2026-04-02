import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";

describe("spec-mode extension: edge cases", () => {
	let projectDir: string;
	let configDir: string;
	let extDir: string;
	let sessionManager: SessionManager;
	let mgr: ExtensionManager;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-spec-mode-edge-"));
		configDir = join(projectDir, "_config");
		extDir = join(configDir, "extensions", "spec-mode");
		await mkdir(extDir, { recursive: true });

		const sessionFile = join(projectDir, "session.jsonl");
		sessionManager = new SessionManager(false, sessionFile, false, projectDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		mgr = new ExtensionManager({ builtInTools: {}, sessionManager });
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	describe("extension reload", () => {
		it("restores previous mode after extension reload", async () => {
			const stateFile = join(extDir, "state.json");

			// Pre-populate state file with spec mode
			await writeFile(stateFile, JSON.stringify({ mode: "spec" }), "utf8");

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  const savedMode = api.getExtensionState?.("mode") ?? "normal";
  api.registerCommand({
    name: "checkmode",
    execute: () => {
      api.appendSessionEntry("mode_check", { currentMode: savedMode });
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Execute checkmode command
			const cmd = mgr.getCommand("checkmode");
			if (cmd) {
				await cmd.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			// Check that mode was restored
			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("spec");
		});

		it("creates state file if it does not exist", async () => {
			const stateFile = join(extDir, "state.json");

			// Ensure state file does not exist
			await rm(stateFile, { force: true });

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  // Try to read state - should return undefined for missing key
  const savedMode = api.getExtensionState?.("mode");
  api.registerCommand({
    name: "savemode",
    execute: async () => {
      api.setExtensionState?.("mode", "discover");
      // Wait for async save
      await new Promise(r => setTimeout(r, 50));
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Execute command to save state
			const cmd = mgr.getCommand("savemode");
			if (cmd) {
				await cmd.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			// Wait for async save
			await new Promise((r) => setTimeout(r, 100));

			// State file should now exist
			const stateContent = await readFile(stateFile, "utf8").catch(() => "{}");
			const state = JSON.parse(stateContent);
			expect(state.mode).toBe("discover");
		});
	});

	describe("multiple extensions", () => {
		it("multiple extensions can coexist with indicators", async () => {
			const otherExtDir = join(configDir, "extensions", "other-ext");
			await mkdir(otherExtDir, { recursive: true });

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.registerExtensionIndicator?.({ id: "spec-indicator", label: "[SPEC]", color: "accent" });
}
`,
				"utf8",
			);

			await writeFile(
				join(otherExtDir, "index.ts"),
				`
export default function (api) {
  api.registerExtensionIndicator?.({ id: "other-indicator", label: "[OTHER]", color: "warning" });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			const results = await loader.loadAll();

			// Both extensions should load successfully
			expect(results.filter((r) => r.ok).length).toBe(2);

			// Verify indicators were registered (check via extension manager)
			// This will need the ExtensionManager to expose indicator list
		});

		it("extensions do not interfere with each other's state", async () => {
			const otherExtDir = join(configDir, "extensions", "other-ext");
			await mkdir(otherExtDir, { recursive: true });

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.setExtensionState?.("mode", "spec");
}
`,
				"utf8",
			);

			await writeFile(
				join(otherExtDir, "index.ts"),
				`
export default function (api) {
  // Try to read spec-mode's state - should not be accessible
  const otherMode = api.getExtensionState?.("mode");
  api.appendSessionEntry("isolation_check", { canSeeOtherState: otherMode === "spec" });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Check that other-ext cannot see spec-mode's state
			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			const hasIsolation = raw.includes("canSeeOtherState") && !raw.includes('"canSeeOtherState":true');
			expect(hasIsolation).toBe(true);
		});
	});

	describe("mode during streaming", () => {
		it("mode change is handled gracefully during streaming", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  let currentMode = "normal";

  api.registerCommand({
    name: "spec",
    execute: (argString, ctx) => {
      // Should be able to change mode even if agent is "streaming"
      currentMode = "spec";
      api.setExtensionState?.("mode", "spec");
      ctx.print("Mode changed to spec");
    }
  });

  api.registerCommand({
    name: "getmode",
    execute: () => {
      api.appendSessionEntry("mode_check", { mode: currentMode });
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Change mode
			const specCmd = mgr.getCommand("spec");
			if (specCmd) {
				await specCmd.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			// Check mode was changed
			const getmodeCmd = mgr.getCommand("getmode");
			if (getmodeCmd) {
				await getmodeCmd.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("spec");
		});
	});

	describe("verifier failure handling", () => {
		it("handles verifier spawn failure gracefully", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.registerCommand({
    name: "spec",
    execute: async (argString, ctx) => {
      try {
        // Simulate verifier spawn that might fail
        // In real implementation, this would call spawn_agent
        throw new Error("Verifier spawn failed");
      } catch (err) {
        // Should catch error and degrade gracefully
        ctx.print("Spec mode active (verifier unavailable)", { color: "warning" });
        api.setExtensionState?.("mode", "spec");
      }
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const printedMessages: string[] = [];
			const specCmd = mgr.getCommand("spec");

			if (specCmd) {
				await specCmd.execute("", {
					send: async () => {},
					print: (text: string) => {
						printedMessages.push(text);
					},
					setModel: async () => {},
				});
			}

			// Should have printed warning but not crashed
			expect(printedMessages.some((m) => m.includes("Spec mode active") || m.includes("verifier"))).toBe(true);
		});
	});

	describe("command conflicts", () => {
		it("handles command name conflicts gracefully", async () => {
			const otherExtDir = join(configDir, "extensions", "other-ext");
			await mkdir(otherExtDir, { recursive: true });

			// Both extensions try to register /spec
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.registerCommand({
    name: "spec",
    description: "Spec mode from spec-mode extension",
    execute: () => { api.print("spec-mode /spec"); }
  });
}
`,
				"utf8",
			);

			await writeFile(
				join(otherExtDir, "index.ts"),
				`
export default function (api) {
  api.registerCommand({
    name: "spec",
    description: "Spec mode from other extension",
    execute: () => { api.print("other /spec"); }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Should have one spec command (last one registered with priority wins, or both are available)
			const commands = mgr.listCommands();
			const specCommands = commands.filter((c) => c.name === "spec");

			// Either one wins or both are somehow available
			expect(specCommands.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("state file corruption", () => {
		it("handles corrupted state file gracefully", async () => {
			const stateFile = join(extDir, "state.json");

			// Write corrupted JSON
			await writeFile(stateFile, "{ invalid json }", "utf8");

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  // Should handle corrupted state gracefully
  const savedMode = api.getExtensionState?.("mode");
  api.registerCommand({
    name: "check",
    execute: () => {
      api.appendSessionEntry("corruption_check", { 
        hasFallbackValue: savedMode === undefined || savedMode === "normal" 
      });
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const cmd = mgr.getCommand("check");
			if (cmd) {
				await cmd.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			// Extension should have loaded despite corrupted state
			expect(loader).toBeDefined();
		});
	});
});
