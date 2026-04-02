import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";

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
		const reminder = String(systemMessage?.content);
		expect(reminder).toContain("ACTIVE MODE: SPEC (READ-ONLY)");
		expect(reminder).toContain("Do not modify repository source files");
		expect(reminder).toContain("Do not use apply_patch, edit, write");
		expect(reminder).toContain("must use ask_user before finalizing");
		expect(reminder).toContain("boundaries, abstractions, tradeoffs, and what matters most");
		expect(reminder).toContain("Definition of Done");
		expect(reminder).toContain("What needs to be done to deliver the spec");
		expect(reminder).toContain("expendable scripts in /tmp");
	});
});
