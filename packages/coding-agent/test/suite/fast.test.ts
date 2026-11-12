import { afterEach, describe, expect, it } from "vitest";
import fastExtension from "../../src/extensions/fast/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const fixtures: Harness[] = [];
afterEach(() => {
	for (const harness of fixtures.splice(0)) harness.cleanup();
});

async function fixture() {
	const harness = await createHarness({ extensionFactories: [fastExtension] });
	fixtures.push(harness);
	const codex = { ...harness.getModel(), provider: "openai-codex", api: "openai-codex-responses" };
	harness.session.agent.state.model = codex;
	const statuses = new Map<string, string>();
	const notices: string[] = [];
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			setStatus: (key, text) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify: (message) => {
				notices.push(message);
			},
		}),
	});
	return {
		harness,
		codex,
		statuses,
		notices,
		payload: () =>
			harness.session.extensionRunner.emitBeforeProviderRequest({ model: "smoke", service_tier: "auto", input: [] }),
	};
}

describe("native Codex fast mode", () => {
	it("requests priority only while enabled and persists transitions", async () => {
		const { harness, statuses, payload } = await fixture();
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.prompt("/fast on");
		expect(await payload()).toMatchObject({ model: "smoke", service_tier: "priority", input: [] });
		expect(statuses.get("fast")).toBe("fast (priority)");
		await harness.session.prompt("/fast off");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		expect(statuses.has("fast")).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "chatgpt-fast-mode")
				.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
		).toEqual([{ enabled: true }, { enabled: false }]);
		expect(harness.eventsOfType("turn_start")).toHaveLength(0);
	});

	it("restores existing session entries and follows branch navigation instead of leaking another branch's tier", async () => {
		const { harness, payload } = await fixture();
		harness.sessionManager.appendCustomEntry("chatgpt-fast-mode", { enabled: true });
		const enabledEntry = harness.sessionManager.getLeafId()!;
		await harness.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(await payload()).toMatchObject({ service_tier: "priority" });
		await harness.session.prompt("/fast off");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.navigateTree(enabledEntry, { summarize: false });
		expect(await payload()).toMatchObject({ service_tier: "priority" });
	});

	it("does not apply priority to other providers and permits disabling a remembered inactive setting", async () => {
		const { harness, codex, statuses, notices, payload } = await fixture();
		await harness.session.prompt("/fast on");
		const other = harness.getModel();
		harness.session.agent.state.model = other;
		await harness.session.extensionRunner.emit({
			type: "model_select",
			model: other,
			previousModel: codex,
			source: "set",
		});
		expect(statuses.get("fast")).toBe("fast (inactive)");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		await harness.session.prompt("/fast off");
		await harness.session.prompt("/fast on");
		expect(notices.at(-1)).toContain("requires a ChatGPT/Codex model");
		expect(await payload()).toMatchObject({ service_tier: "auto" });
		expect(statuses.has("fast")).toBe(false);
	});

	it("keeps separate sessions independent and rejects invalid commands without enabling priority", async () => {
		const first = await fixture();
		const second = await fixture();
		await first.harness.session.prompt("/fast on");
		await second.harness.session.prompt("/fast bogus");
		expect(await first.payload()).toMatchObject({ service_tier: "priority" });
		expect(await second.payload()).toMatchObject({ service_tier: "auto" });
		expect(second.notices.at(-1)).toContain("Usage:");
	});
});
