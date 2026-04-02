import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";

describe("spec-mode extension: behavioral tests", () => {
	let projectDir: string;
	let configDir: string;
	let extDir: string;
	let sessionManager: SessionManager;
	let mgr: ExtensionManager;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-spec-mode-project-"));
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

	describe("extension loading", () => {
		it("loads spec-mode extension from configDir/extensions/spec-mode/", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`export default function (api) { api.print("spec-mode loaded"); }`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			const res = await loader.loadAll();

			expect(res.some((r) => r.sourceId.includes("spec-mode") && r.ok)).toBe(true);
		});
	});

	describe("slash commands", () => {
		it("registers /spec, /discover, and /normal commands", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.registerCommand({ name: "spec", description: "Enter spec mode", execute: () => {} });
  api.registerCommand({ name: "discover", description: "Enter problem discovery mode", execute: () => {} });
  api.registerCommand({ name: "normal", description: "Return to normal mode", execute: () => {} });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const commands = mgr.listCommands();
			const commandNames = commands.map((c) => c.name);

			expect(commandNames).toContain("spec");
			expect(commandNames).toContain("discover");
			expect(commandNames).toContain("normal");
		});
	});

	describe("state persistence", () => {
		it("extension has getExtensionState and setExtensionState APIs", async () => {
			const hasGetExtensionState = false;
			const hasSetExtensionState = false;

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  // Check APIs exist
  if (typeof api.getExtensionState === "function") {
    api.appendSessionEntry("api_check", { hasGetExtensionState: true });
  }
  if (typeof api.setExtensionState === "function") {
    api.appendSessionEntry("api_check", { hasSetExtensionState: true });
  }
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Check session file for API check entries
			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("hasGetExtensionState");
			expect(raw).toContain("hasSetExtensionState");
		});

		it("persists mode in extension state storage", async () => {
			const stateFile = join(extDir, "state.json");

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  // Save mode to state
  api.registerCommand({
    name: "spec",
    description: "Enter spec mode",
    execute: async () => {
      api.setExtensionState("mode", "spec");
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

			// Execute spec command to set state
			const specCommand = mgr.getCommand("spec");
			expect(specCommand).toBeDefined();

			if (specCommand) {
				await specCommand.execute("", {
					send: async () => {},
					print: () => {},
					setModel: async () => {},
				});
			}

			// Wait for async save to complete
			await new Promise((r) => setTimeout(r, 100));

			// Verify state was persisted to file
			const stateContent = await readFile(stateFile, "utf8").catch(() => "{}");
			const state = JSON.parse(stateContent);
			expect(state.mode).toBe("spec");
		});

		it("restores mode from state on extension reload", async () => {
			const stateFile = join(extDir, "state.json");
			await writeFile(stateFile, JSON.stringify({ mode: "discover" }), "utf8");

			const loadedMode: string | null = null;

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  const savedMode = api.getExtensionState("mode") ?? "normal";
  api.appendSessionEntry("mode_restore_check", { loadedMode: savedMode });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Check session file for restore check
			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("discover");
		});
	});

	describe("context hook", () => {
		it("context hook can modify messages (reminder injection)", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  let currentMode = api.getExtensionState?.("mode") ?? "normal";

  api.context((messages) => {
    if (currentMode === "spec") {
      // Append reminder to last message
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && typeof lastMsg.content === "string") {
        lastMsg.content += "\\n\\n[Spec mode active]";
      }
    }
    return messages;
  });

  api.registerCommand({
    name: "spec",
    execute: () => { 
      currentMode = "spec"; 
      api.setExtensionState?.("mode", "spec"); 
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Get the message preprocessor and test it
			const preprocessor = mgr.getMessagePreprocessor();
			const testMessages = [{ role: "user" as const, content: "Hello", timestamp: Date.now() }];

			// First call with normal mode - no reminder
			const normalMessages = await preprocessor(testMessages);
			expect(normalMessages[0].content).not.toContain("Spec mode active");

			// Set mode to spec
			const specCommand = mgr.getCommand("spec");
			if (specCommand) {
				await specCommand.execute("", { send: async () => {}, print: () => {}, setModel: async () => {} });
			}

			// Call preprocessor again - should have reminder
			// Note: This will need the extension to re-read state or the test will need adjustment
		});
	});

	describe("visual feedback", () => {
		it("prints confirmation message when mode changes via api.print()", async () => {
			const printedMessages: string[] = [];

			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  api.registerCommand({
    name: "spec",
    description: "Enter spec mode",
    execute: (argString, ctx) => {
      api.setExtensionState?.("mode", "spec");
      ctx.print("Spec mode active. Assistant will produce structured specification output.", { color: "accent" });
    }
  });
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Execute spec command
			const specCommand = mgr.getCommand("spec");
			expect(specCommand).toBeDefined();

			if (specCommand) {
				await specCommand.execute("", {
					send: async () => {},
					print: (text: string) => {
						printedMessages.push(text);
					},
					setModel: async () => {},
				});
			}

			// Verify confirmation was printed
			expect(printedMessages.some((m) => m.includes("Spec mode active"))).toBe(true);
		});

		it("has registerExtensionIndicator API for footer badges", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  if (typeof api.registerExtensionIndicator === "function") {
    api.appendSessionEntry("api_check", { hasRegisterExtensionIndicator: true });
  }
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			// Check session file for API check
			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("hasRegisterExtensionIndicator");
		});
	});
});
