import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";

const EXPECTED_SPEC_REMINDER = `## Specification Notes:
Below is the structure expected in your response after you're done with your specification analysis.
1. Summary & Recommendation
2. What Must be True
3. What Must Never Happen
4. Inputs / Outputs
5. Edge Cases 
6. Constraints
7. Definition of Done
- It's important that we have legible ways to verify that the implementation is done, like in a red/green tdd style approach, such as diffs, logs, assertions
- For UI, if needed, it's helpful that we use cdp (browser) or xtui (tui/cli). These are the best tools for verification.
8. What needs to be done to deliver the spec, verified by expendable scripts in /tmp that:
- Import the actual modules
- Exercise specific behaviors with known inputs
- Assert expected outputs or log actual state
- Test your assumptions, not just "explore"
Each test should validate or invalidate a thesis statement / hypothesis.
If you can't see the behavior (logs, assertions, outputs), you're guessing.
Correctness must be executable, so we need a verification contract.

Exhaust specification analysis through more tests before asking or user clarification. Do not edit source files.

## Archictecture Notes:
Using ask_user, propose and request for human approval on the following:
• boundaries
• abstractions
• tradeoffs
• what matters

The proposal must be clear on the action you recommend to take and why. Must be concise.`;

describe("spec-mode actual reminders", () => {
	let projectDir: string;
	let configDir: string;
	let extDir: string;
	let sessionFile: string;
	let sessionManager: SessionManager;
	let mgr: ExtensionManager;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-spec-mode-reminders-"));
		configDir = join(projectDir, "_config");
		extDir = join(configDir, "extensions", "spec-mode");
		sessionFile = join(projectDir, "session.jsonl");
		await mkdir(join(configDir, "extensions"), { recursive: true });
		await cp(join(homedir(), ".mu", "agent", "extensions", "spec-mode"), extDir, { recursive: true });

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

	it("injects a strict discover reminder and records mode activation", async () => {
		const loader = new ExtensionLoader(mgr, { projectDir, configDir });
		await loader.loadAll();

		await mgr.getCommand("discover")?.execute("", {
			send: async () => {},
			print: () => {},
			setModel: async () => {},
		});

		const preprocessor = mgr.getMessagePreprocessor();
		const messages = await preprocessor([{ role: "user" as const, content: "hello", timestamp: Date.now() }]);

		const systemMessage = messages[0];
		expect(typeof systemMessage?.content).toBe("string");
		const reminder = String(systemMessage?.content);
		expect(reminder).toContain("ACTIVE MODE: DISCOVER (READ-ONLY)");
		expect(reminder).toContain("Do not modify repository source files");
		expect(reminder).toContain("Do not use apply_patch, edit, write");
		expect(reminder).toContain("Use expendable scripts in /tmp");
		expect(reminder).toContain("must use ask_user before finalizing");
		expect(reminder).toContain("Problem Statement & Recommendation");

		const rawSession = await readFile(sessionFile, "utf8");
		expect(rawSession).toContain('"customType":"spec_mode"');
		expect(rawSession).toContain('"mode":"discover"');
		expect(rawSession).toContain('"source":"command"');
	});

	it("injects a strict spec reminder with architecture approval guidance", async () => {
		const loader = new ExtensionLoader(mgr, { projectDir, configDir });
		await loader.loadAll();

		await mgr.getCommand("spec")?.execute("", {
			send: async () => {},
			print: () => {},
			setModel: async () => {},
		});

		const preprocessor = mgr.getMessagePreprocessor();
		const messages = await preprocessor([{ role: "user" as const, content: "hello", timestamp: Date.now() }]);

		const systemMessage = messages[0];
		expect(typeof systemMessage?.content).toBe("string");
		const reminder = String(systemMessage?.content).trim();
		expect(reminder).toBe(EXPECTED_SPEC_REMINDER);
	});
});
