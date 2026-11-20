import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("thinking level on model switches", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ method: "set", reasoning: true },
		{ method: "set", reasoning: false },
		{ method: "cycle", reasoning: true },
		{ method: "cycle", reasoning: false },
		{ method: "scoped", reasoning: true },
		{ method: "scoped", reasoning: false },
	])("retains the level with $method and target reasoning=$reasoning", async ({ method, reasoning }) => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);
		const { session } = harness;
		const first = harness.getModel("faux-1")!;
		const second = harness.getModel("faux-2")!;
		if (method === "scoped") session.setScopedModels([{ model: first }, { model: second }]);

		session.setThinkingLevel("high");
		if (method === "set") await session.setModel(second);
		else await session.cycleModel("forward");
		expect(session.model?.id).toBe(second.id);
		expect(session.thinkingLevel).toBe(reasoning ? "high" : "off");

		if (method === "set") await session.setModel(first);
		else await session.cycleModel("backward");
		expect(session.model?.id).toBe(first.id);
		expect(session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");

		const expectedLevels = reasoning ? ["high"] : ["high", "off", "high"];
		expect(harness.eventsOfType("thinking_level_changed").map((event) => event.level)).toEqual(expectedLevels);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "thinking_level_change")
				.map((entry) => entry.thinkingLevel),
		).toEqual(expectedLevels);
	});

	it("keeps the original value through multiple capability clamps", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
				{ id: "faux-3", reasoning: true },
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		const first = harness.getModel()!;
		first.thinkingLevelMap = { max: "max" };
		session.setThinkingLevel("max");

		await session.setModel(harness.getModel("faux-2")!);
		expect(session.thinkingLevel).toBe("off");
		await session.setModel(harness.getModel("faux-3")!);
		expect(session.thinkingLevel).toBe("high");
		await session.setModel(harness.getModel("faux-2")!);
		expect(session.thinkingLevel).toBe("off");
		await session.setModel(first);
		expect(session.thinkingLevel).toBe("max");
		expect(Reflect.get(session, "_thinkingLevelBeforeClamp")).toBeUndefined();
	});

	it.each([false, true])("remembers a clamped setter value with persist=%s", async (persist) => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: true },
			],
			settings: { defaultThinkingLevel: "low" },
		});
		harnesses.push(harness);
		const { session } = harness;
		const second = harness.getModel("faux-2")!;
		second.thinkingLevelMap = { max: "max" };

		session.setThinkingLevel("high");
		session.setThinkingLevel("max", { persist });
		expect(session.thinkingLevel).toBe("high");
		expect(harness.eventsOfType("thinking_level_changed")).toHaveLength(1);
		await session.setModel(second);
		expect(session.thinkingLevel).toBe("max");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(persist ? "max" : "low");
	});

	it.each(["set", "cycle"])(
		"discards the cached value after a different supported selection via %s",
		async (method) => {
			const harness = await createHarness({
				models: [
					{ id: "faux-1", reasoning: true },
					{ id: "faux-2", reasoning: true },
				],
			});
			harnesses.push(harness);
			const { session } = harness;
			const first = harness.getModel()!;
			first.thinkingLevelMap = { max: "max" };
			session.setThinkingLevel("max");
			await session.setModel(harness.getModel("faux-2")!);
			expect(session.thinkingLevel).toBe("high");

			if (method === "set") session.setThinkingLevel("low");
			else expect(session.cycleThinkingLevel()).toBe("off");
			await session.setModel(first);
			expect(session.thinkingLevel).toBe(method === "set" ? "low" : "off");
		},
	);

	it.each([
		{ source: "session", persist: false },
		{ source: "session", persist: true },
		{ source: "extension", persist: false },
	])("same-value $source setter preserves the clamp cache with persist=$persist", async ({ source, persist }) => {
		let extensionApi: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
			settings: { defaultThinkingLevel: "medium" },
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		session.setThinkingLevel("high");
		await session.setModel(harness.getModel("faux-2")!);
		if (source === "session") session.setThinkingLevel("off", { persist });
		else {
			if (!extensionApi) throw new Error("Expected extension API");
			extensionApi.setThinkingLevel("off");
		}
		expect(harness.eventsOfType("thinking_level_changed")).toHaveLength(2);
		await session.setModel(harness.getModel("faux-1")!);
		expect(session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe(persist ? "off" : "medium");
	});

	it.each([
		{ source: "per-model", level: "low" },
		{ source: "per-model", level: "off" },
		{ source: "scoped", level: "low" },
		{ source: "scoped", level: "off" },
	] as const)("$source override $level replaces the cached level", async ({ source, level }) => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
				{ id: "faux-3", reasoning: true },
			],
			settings: {
				defaultThinkingLevel: "medium",
				modelThinkingLevels: { "faux/faux-3": source === "scoped" ? "minimal" : level },
			},
		});
		harnesses.push(harness);
		const { session } = harness;
		const first = harness.getModel()!;
		const second = harness.getModel("faux-2")!;
		const third = harness.getModel("faux-3")!;
		if (source === "scoped") {
			session.setScopedModels([{ model: first }, { model: second }, { model: third, thinkingLevel: level }]);
		}
		session.setThinkingLevel("high");
		await session.setModel(second);
		expect(session.thinkingLevel).toBe("off");
		if (source === "scoped") await session.cycleModel();
		else await session.setModel(third);
		expect(session.thinkingLevel).toBe(level);
		await session.setModel(first);
		expect(session.thinkingLevel).toBe(level);
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});

	it("caches the model override itself when that override is clamped", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		harnesses.push(harness);
		const { session } = harness;
		const second = harness.getModel("faux-2")!;
		session.setThinkingLevel("high");
		await session.setModel(second);
		harness.settingsManager.setModelThinkingLevel("faux", second.id, "low");
		await session.setModel(second);
		expect(session.thinkingLevel).toBe("off");
		await session.setModel(harness.getModel()!);
		expect(session.thinkingLevel).toBe("low");
	});

	it.each([
		{ source: "explicit", reasoning: false },
		{ source: "explicit", reasoning: true },
		{ source: "global", reasoning: false },
		{ source: "global", reasoning: true },
		{ source: "per-model", reasoning: false },
		{ source: "per-model", reasoning: true },
		{ source: "built-in", reasoning: false },
		{ source: "built-in", reasoning: true },
	])("inherits the effective $source startup level with reasoning=$reasoning", async ({ source, reasoning }) => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning },
				{ id: "faux-2", reasoning: true },
			],
			settings: {
				defaultThinkingLevel: source === "built-in" ? undefined : "max",
				modelThinkingLevels: source === "per-model" ? { "faux/faux-1": "low" } : undefined,
			},
		});
		harnesses.push(harness);
		const second = harness.getModel("faux-2")!;
		second.thinkingLevelMap = { max: "max" };
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			thinkingLevel: source === "explicit" ? "minimal" : undefined,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const expected = !reasoning
				? "off"
				: source === "explicit"
					? "minimal"
					: source === "per-model"
						? "low"
						: source === "global"
							? "high"
							: "medium";
			expect(session.thinkingLevel).toBe(expected);
			await session.setModel(second);
			expect(session.thinkingLevel).toBe(expected);
		} finally {
			session.dispose();
		}
	});

	it("does not restore the runtime clamp cache when reopening a session", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
			settings: { defaultThinkingLevel: "high" },
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		await harness.session.setModel(harness.getModel("faux-2")!);
		harness.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			sessionManager: harness.sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			expect(session.thinkingLevel).toBe("off");
			await session.setModel(harness.getModel("faux-1")!);
			expect(session.thinkingLevel).toBe("off");
		} finally {
			session.dispose();
		}
	});
});
