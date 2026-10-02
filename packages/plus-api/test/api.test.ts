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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { ExtensionAPI, SessionStartEvent } from "../src/api.ts";
import {
	AGENT_DIR,
	addProfile,
	clearDefaultProfile,
	createAgentSession,
	createPlusAgentSession,
	createPlusUIContext,
	createTerminalAuthInteraction,
	DefaultResourceLoader,
	findProfile,
	getDefaultProfileName,
	loadProfiles,
	loginProvider,
	ModelRuntime,
	materializeProfile,
	plusSdkExtensionFactories,
	profileDirFor,
	removeProfile,
	removeProfileDir,
	renameProfile,
	SessionManager,
	SettingsManager,
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
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("Hello from the faux provider.")]);
		const model = faux.getModel();

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(cwd, "models.json"),
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
