/**
 * Tests for the programmatic library entry (packages/plus-api/src/api.ts) — the
 * surface the "pi-plus-sdk" npm package exposes via its exports map for hosts
 * that embed pi-plus in-process (e.g. a desktop app).
 *
 * The session-construction test uses the faux provider (no real APIs) and an
 * in-memory session/settings manager with temp cwd/agentDir, so it never
 * touches ~/.pi.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../src/api.ts";
import {
	AGENT_DIR,
	addProfile,
	clearDefaultProfile,
	createAgentSession,
	createPlusAgentSession,
	createPlusAgentSessionRuntime,
	createPlusUIContext,
	createTerminalAuthInteraction,
	DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
	DEFAULT_CONTEXT_FLOOR_TOKENS,
	DefaultResourceLoader,
	findProfile,
	getAutoCompactThresholdPercent,
	getContextFloorTokens,
	getContextWindowCapTokens,
	getDefaultProfileName,
	loadProfiles,
	loginProvider,
	ModelRuntime,
	materializeProfile,
	plusSdkExtensionFactories,
	profileDirFor,
	readPlusSettings,
	removeProfile,
	removeProfileDir,
	renameProfile,
	SessionManager,
	SettingsManager,
	setAutoCompactThresholdPercent,
	setContextFloorTokens,
	setContextWindowCapTokens,
	setDefaultProfile,
	syncProfilePackagesToSource,
	THINKING_LEVELS,
	updateProfile,
} from "../src/api.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-plus-api-test-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface FauxHarness {
	faux: ReturnType<typeof registerFauxProvider>;
	model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;
	modelRuntime: ModelRuntime;
}

/** Faux provider + offline ModelRuntime with an in-memory api key, so session
 *  and runtime tests never touch ~/.pi or the network. Callers set responses
 *  and must unregister in a finally block. */
async function createFauxHarness(): Promise<FauxHarness> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(tempDirs[0] ?? tmpdir(), "faux-models.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	return { faux, model, modelRuntime };
}

describe("api entry exports", () => {
	it("exposes the pi-plus additions and the upstream SDK surface", () => {
		expect(typeof createPlusAgentSession).toBe("function");
		expect(typeof createPlusUIContext).toBe("function");
		expect(Array.isArray(plusSdkExtensionFactories)).toBe(true);
		// Upstream re-exports used by SDK hosts.
		expect(typeof createAgentSession).toBe("function");
		expect(typeof SessionManager.inMemory).toBe("function");
		expect(typeof DefaultResourceLoader).toBe("function");
	});

	it("registers exactly the nine non-TUI pi-plus extensions, all hidden", () => {
		// InlineExtension is a union (function form or object form); this entry
		// uses the object form, so narrow before reading name/hidden.
		const factories = plusSdkExtensionFactories.map((extension) => {
			if (typeof extension === "function") throw new Error("expected object-form extension factories");
			return { name: extension.name, hidden: extension.hidden };
		});
		expect(factories.map((extension) => extension.name)).toEqual([
			"pi-plus-subagent",
			"pi-plus-tasks",
			"pi-plus-memory",
			"pi-plus-plan",
			"pi-plus-ask-user",
			"pi-plus-hooks",
			"pi-plus-context-guard",
			"pi-plus-cd",
			"pi-plus-init",
		]);
		for (const extension of factories) {
			expect(extension.hidden).toBe(true);
		}
	});
});

describe("profile management surface", () => {
	it("re-exports the curated pi-hub profile API", () => {
		// Shape-only: hub's own suite covers behavior; calling loadProfiles()
		// here would read the real ~/.pi (config paths are frozen at import).
		for (const fn of [
			addProfile,
			clearDefaultProfile,
			findProfile,
			getDefaultProfileName,
			loadProfiles,
			materializeProfile,
			profileDirFor,
			removeProfile,
			removeProfileDir,
			renameProfile,
			setDefaultProfile,
			syncProfilePackagesToSource,
			updateProfile,
		]) {
			expect(typeof fn).toBe("function");
		}
		expect(typeof AGENT_DIR).toBe("string");
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("provider login surface", () => {
	it("re-exports loginProvider and the terminal interaction", () => {
		expect(typeof loginProvider).toBe("function");
		const interaction = createTerminalAuthInteraction();
		expect(typeof interaction.prompt).toBe("function");
		expect(typeof interaction.notify).toBe("function");
	});

	it("rejects an unknown provider before running any login", async () => {
		// agentDir points at a temp dir so the runtime's auth store never
		// touches ~/.pi; the provider lookup throws before any interaction.
		const agentDir = makeTempDir();
		await expect(loginProvider("no-such-provider-xyz", { agentDir })).rejects.toThrow(/Unknown provider/);
	});
});

describe("session history management", () => {
	it("deleteSession removes a transcript, tolerates missing files, refuses non-jsonl", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-sessions-"));
		try {
			const file = join(dir, "session.jsonl");
			writeFileSync(file, "{}\n");
			expect(SessionManager.deleteSession(file)).toBe(true);
			expect(existsSync(file)).toBe(false);
			// Missing file: false, not a throw.
			expect(SessionManager.deleteSession(file)).toBe(false);
			// Guard: arbitrary files must not be deletable through this API.
			const other = join(dir, "notes.txt");
			writeFileSync(other, "keep me\n");
			expect(() => SessionManager.deleteSession(other)).toThrow(/non-session file/i);
			expect(existsSync(other)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("search matches session name, first message, and any message text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-search-"));
		const header = (id: string, cwd: string) =>
			JSON.stringify({ type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd });
		const msg = (id: string, parentId: string, role: string, text: string) =>
			JSON.stringify({
				type: "message",
				id,
				parentId,
				message: { role, content: [{ type: "text", text }], timestamp: 0 },
			});
		try {
			writeFileSync(
				join(dir, "a.jsonl"),
				[
					header("id-aaa", "/tmp/a"),
					msg("a1", "h", "user", "quantum flux analysis"),
					msg("a2", "a1", "assistant", "the FLUX capacitor hums"),
				].join("\n") + "\n",
			);
			writeFileSync(
				join(dir, "b.jsonl"),
				[
					header("id-bbb", "/tmp/b"),
					JSON.stringify({ type: "session_info", id: "b0", parentId: "h", name: "Zephyr rename target" }),
					msg("b1", "b0", "user", "unrelated"),
				].join("\n") + "\n",
			);
			writeFileSync(
				join(dir, "c.jsonl"),
				[header("id-ccc", "/tmp/c"), msg("c1", "h", "user", "plain nothing")].join("\n") + "\n",
			);

			// Body text hit (case-insensitive, not the first message).
			expect((await SessionManager.search("flux capacitor", dir)).map((s) => s.id)).toEqual(["id-aaa"]);
			// session_info name hit.
			expect((await SessionManager.search("zephyr", dir)).map((s) => s.id)).toEqual(["id-bbb"]);
			// First-message hit.
			expect((await SessionManager.search("plain", dir)).map((s) => s.id)).toEqual(["id-ccc"]);
			expect(await SessionManager.search("   ", dir)).toEqual([]);
			expect(await SessionManager.search("no-such-text", dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pi-plus context settings", () => {
	it("threshold/floor/cap round-trip through the settings file", () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-sdk-settings-"));
		const file = join(dir, "pi-plus-settings.json");
		const previous = process.env.PI_PLUS_SETTINGS_FILE;
		process.env.PI_PLUS_SETTINGS_FILE = file;
		try {
			// Defaults with no file present.
			expect(getAutoCompactThresholdPercent()).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
			expect(getContextFloorTokens()).toBe(DEFAULT_CONTEXT_FLOOR_TOKENS);
			expect(getContextWindowCapTokens()).toBeUndefined();
			// Persist and read back.
			setAutoCompactThresholdPercent(95);
			setContextFloorTokens(32768);
			setContextWindowCapTokens(262144);
			expect(readPlusSettings()).toEqual({
				autoCompactThresholdPercent: 95,
				contextFloorTokens: 32768,
				contextWindowCapTokens: 262144,
			});
			// Reset removes the key (undefined = default / no cap).
			setAutoCompactThresholdPercent(undefined);
			setContextFloorTokens(undefined);
			setContextWindowCapTokens(undefined);
			expect(readPlusSettings()).toEqual({});
			expect(getAutoCompactThresholdPercent()).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT);
		} finally {
			if (previous === undefined) delete process.env.PI_PLUS_SETTINGS_FILE;
			else process.env.PI_PLUS_SETTINGS_FILE = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createPlusUIContext", () => {
	it("delegates dialogs to host handlers in ask-user fallback argument order", async () => {
		const calls: unknown[] = [];
		const ui = createPlusUIContext({
			select: async (title, options) => {
				calls.push(["select", title, options]);
				return options[1];
			},
			confirm: async (title, message) => {
				calls.push(["confirm", title, message]);
				return true;
			},
			input: async (title, placeholder) => {
				calls.push(["input", title, placeholder]);
				return "typed";
			},
			editor: async (title, prefill) => {
				calls.push(["editor", title, prefill]);
				return "edited";
			},
			notify: (message, type) => {
				calls.push(["notify", message, type]);
			},
		});
		expect(await ui.select("Header: Question?", ["a", "Other"])).toBe("Other");
		expect(await ui.confirm("Header", 'Include "x"?')).toBe(true);
		expect(await ui.input("Header", "Your answer")).toBe("typed");
		expect(await ui.editor("Title", "pre")).toBe("edited");
		ui.notify("heads up", "warning");
		expect(calls).toEqual([
			["select", "Header: Question?", ["a", "Other"]],
			["confirm", "Header", 'Include "x"?'],
			["input", "Header", "Your answer"],
			["editor", "Title", "pre"],
			["notify", "heads up", "warning"],
		]);
	});

	it("tolerates a missing editor/notify and no-ops terminal-only members", async () => {
		const ui = createPlusUIContext({
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		});
		expect(await ui.editor("Title")).toBeUndefined();
		expect(ui.getEditorText()).toBe("");
		expect(ui.getToolsExpanded()).toBe(false);
		expect(ui.getAllThemes()).toEqual([]);
		expect(() => ui.setTitle("x")).not.toThrow();
		// The `theme` getter is live (initTheme ran during creation).
		expect(typeof ui.theme.fg).toBe("function");
	});
});

describe("createPlusAgentSession", () => {
	it("loads the pi-plus extensions, emits session_start once, and answers a prompt", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		faux.setResponses([fauxAssistantMessage("Hello from the faux provider.")]);

		const sessionStarts: string[] = [];
		const { session, extensionsResult } = await createPlusAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			// Observer proves host factories are appended after the pi-plus ones
			// and that bindExtensions emits session_start exactly once.
			extensionFactories: [
				{
					name: "test-observer",
					factory: (pi: ExtensionAPI) => {
						pi.on("session_start", (event: SessionStartEvent) => {
							sessionStarts.push(event.reason);
						});
					},
				},
			],
		});
		try {
			const toolNames = new Set(
				extensionsResult.extensions.flatMap((extension) => Array.from(extension.tools.keys())),
			);
			for (const expected of [
				"ask_user",
				"TaskCreate",
				"TaskUpdate",
				"TaskList",
				"TaskGet",
				"EnterPlanMode",
				"ExitPlanMode",
				"memory_save",
				"memory_recall",
				"subagent",
			]) {
				expect(toolNames.has(expected)).toBe(true);
			}

			await session.prompt("Say hello");
			expect(session.getLastAssistantText()).toBe("Hello from the faux provider.");
			expect(sessionStarts).toEqual(["startup"]);
		} finally {
			session.dispose();
			faux.unregister();
		}
	}, 30000);
});

describe("createPlusAgentSessionRuntime", () => {
	// Observer extension shared by the tests: records every session_start /
	// session_shutdown the runtime drives, proving one bind per session.
	function makeRuntimeObserver() {
		const sessionStarts: string[] = [];
		const shutdowns: string[] = [];
		let rebinds = 0;
		return {
			sessionStarts,
			shutdowns,
			get rebinds() {
				return rebinds;
			},
			onRebind: () => {
				rebinds += 1;
			},
			factory: {
				name: "test-runtime-observer",
				factory: (pi: ExtensionAPI) => {
					pi.on("session_start", (event: SessionStartEvent) => {
						sessionStarts.push(event.reason);
					});
					pi.on("session_shutdown", (event: SessionShutdownEvent) => {
						shutdowns.push(event.reason);
					});
				},
			},
		};
	}

	it("binds once per session: startup, clone (fork at leaf), and switchSession all rebind", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const sessionDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		faux.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Cloned continuation.")]);
		const observer = makeRuntimeObserver();

		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			expect(observer.sessionStarts).toEqual(["startup"]);
			expect(observer.rebinds).toBe(1);

			const session = runtime.session;
			await session.prompt("Say hello");
			expect(session.getLastAssistantText()).toBe("First reply.");
			const originalFile = session.sessionFile;
			expect(originalFile && existsSync(originalFile)).toBe(true);
			const messageCountBefore = session.messages.length;

			// clone = fork at the leaf, in place: new file, same history, one rebind
			const leafId = session.sessionManager.getLeafId();
			expect(leafId).toBeTruthy();
			const clone = await runtime.fork(leafId!, { position: "at" });
			expect(clone.cancelled).toBe(false);
			expect(observer.sessionStarts).toEqual(["startup", "fork"]);
			expect(observer.rebinds).toBe(2);
			const cloned = runtime.session;
			expect(cloned).not.toBe(session);
			expect(cloned.sessionFile).not.toBe(originalFile);
			expect(cloned.messages.length).toBe(messageCountBefore);
			expect(cloned.sessionManager.getSessionDir()).toBe(sessionDir);

			await cloned.prompt("Continue");
			expect(cloned.getLastAssistantText()).toBe("Cloned continuation.");

			// switchSession resumes the original file (clone kept it on disk)
			const back = await runtime.switchSession(originalFile!);
			expect(back.cancelled).toBe(false);
			expect(observer.sessionStarts).toEqual(["startup", "fork", "resume"]);
			expect(observer.rebinds).toBe(3);
			expect(runtime.session.getLastAssistantText()).toBe("First reply.");
			expect(runtime.cwd).toBe(cwd);
		} finally {
			await runtime.dispose();
			expect(observer.shutdowns.length).toBeGreaterThan(0);
			faux.unregister();
		}
	}, 30000);

	it("fork before the first assistant response throws the CLI's not-saved guard", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const sessionDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		const observer = makeRuntimeObserver();

		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			// A user entry exists (so the leaf is valid) but the file has not
			// been flushed yet — SessionManager writes only after the first
			// assistant message.
			runtime.session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hi" }],
				timestamp: Date.now(),
			});
			const leafId = runtime.session.sessionManager.getLeafId();
			expect(leafId).toBeTruthy();
			expect(runtime.session.sessionFile && existsSync(runtime.session.sessionFile)).toBe(false);
			await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(/has not been saved yet/);
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	}, 30000);

	it("routes /cd through the runtime actions wired for embedding hosts", async () => {
		const cwd = makeTempDir();
		const agentDir = makeTempDir();
		const targetDir = makeTempDir();
		const { faux, model, modelRuntime } = await createFauxHarness();
		const observer = makeRuntimeObserver();

		// /cd relocates into getDefaultSessionDir(target) — with no agentDir
		// argument it resolves through PI_CODING_AGENT_DIR, so point that at
		// the temp agent dir to keep the test out of the real ~/.pi.
		const previousEnv = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const runtime = await createPlusAgentSessionRuntime({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: [observer.factory],
			onRebind: observer.onRebind,
		});

		try {
			// createPlusAgentSession cannot run /cd at all (no switchSession
			// action); the runtime default actions must make it work.
			await runtime.session.prompt(`/cd ${targetDir}`);
			expect(runtime.cwd).toBe(targetDir);
			expect(observer.sessionStarts).toEqual(["startup", "resume"]);
			expect(observer.rebinds).toBe(2);
			// The relocated session lives under the target cwd's default dir
			// (getDefaultSessionDir(target) resolves through the env agent dir).
			const targetSlug = `--${targetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const sessionFile = runtime.session.sessionFile;
			expect(sessionFile?.startsWith(join(agentDir, "sessions", targetSlug))).toBe(true);
		} finally {
			await runtime.dispose();
			faux.unregister();
			if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousEnv;
		}
	}, 30000);
});

describe("api.d.ts drift guard", () => {
	it("declares every runtime export of src/api.ts", () => {
		const plusDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const runtimeSource = readFileSync(join(plusDir, "src", "api.ts"), "utf8");
		const declarationSource = readFileSync(join(plusDir, "api.d.ts"), "utf8");
		// `export * from` barrel re-exports are covered by api.d.ts's own
		// `export * from "@earendil-works/pi-coding-agent"`; named exports must
		// each appear in the declaration file.
		const namedExports = new Set<string>();
		for (const match of runtimeSource.matchAll(
			/export\s+(?:async\s+)?(?:function|const|interface)\s+([A-Za-z0-9_]+)/g,
		)) {
			namedExports.add(match[1]);
		}
		assert.ok(namedExports.size >= 4, `expected named exports in api.ts, got: ${[...namedExports].join(", ")}`);
		for (const name of namedExports) {
			assert.ok(declarationSource.includes(name), `api.d.ts is missing a declaration for api.ts export "${name}"`);
		}
	});
});
