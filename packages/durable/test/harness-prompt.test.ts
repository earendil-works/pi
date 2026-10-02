import { type SystemMessage, type Tool, Type } from "@earendil-works/pi-ai";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	type EntryId,
	MemoryStorage,
	type PromptInput,
	type PromptSection,
	SystemEntry,
	type ToolRegistration,
	wrapSection,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { resolveAgent, resolveSettings } from "../src/harness/agent.ts";
import { planSystemEntries, renderSections, replaySections } from "../src/harness/prompt.ts";
import { addSection, openHarness, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

type Planned = { readonly sections: Record<string, string | null>; readonly omit?: readonly EntryId[] };

/** Plan against the current context, append the plan, and check that replay then yields `desired` in order. */
async function apply(conversation: Conversation, desired: Record<string, string>): Promise<Planned[]> {
	const drafts = planSystemEntries(await conversation.context(context), new Map(Object.entries(desired)), [], 7);
	await conversation.commit(async (tx) => {
		for (const draft of drafts) await tx.appendEntry(SystemEntry, conversation.id, draft);
	}, context);
	const replayed = replaySections((await conversation.context(context)).messages);
	expect([...replayed]).toEqual(Object.entries(desired));
	return drafts.map((draft) => {
		const message = draft.model![0] as SystemMessage;
		expect(message).toMatchObject({ role: "system", content: "", timestamp: 7 });
		const omit = draft.edits?.map((edit) => {
			expect(edit.action).toBe("omit");
			return edit.target;
		});
		return omit === undefined ? { sections: message.sections! } : { sections: message.sections!, omit };
	});
}

async function root(): Promise<Conversation> {
	const { harness } = await openHarness(new MemoryStorage());
	return harness.root(context);
}

async function lastSystemId(conversation: Conversation): Promise<EntryId> {
	const page = await conversation.entries({}, 100, undefined, context);
	return page.items.find((entry) => entry.kind === "pi.system")!.id;
}

async function marker(conversation: Conversation, head: EntryId | "self"): Promise<EntryId> {
	return conversation.commit(
		async (tx) => (await tx.appendEntry(conversation.id, { kind: "summary", head, model: [user("summary")] })).id,
		context,
	);
}

function section(key: string, render: PromptSection<ToolRegistration>["render"], tag?: boolean) {
	return tag === undefined ? { key, render } : { key, render, tag };
}

const input: PromptInput<ToolRegistration> = {
	conversationId: 1 as never,
	agent: { thinkingLevel: "off", extensions: [], tools: [], sections: [] },
	env: undefined,
	shown: {},
	read: { snapshot: async () => undefined, snapshotAsOf: async () => undefined },
};

describe("system prompt preparation", () => {
	it("renders sections in order with tags, omissions, wrappers, and failures", async () => {
		const registry = createRegistry();
		addSection(registry, "preamble", () => "You are helpful.", { tag: false });
		addSection(registry, "cwd", async () => "/repo");
		addSection(registry, "skipped", () => undefined);
		addSection(registry, "failing", () => {
			throw new Error("render failed");
		});
		addSection(registry, "new-failing", () => {
			throw new Error("also failed");
		});
		registry.install(
			defineExtension({
				name: "git",
				wraps: [
					wrapSection("cwd", (inner) => ({
						...inner,
						render: async (value, ctx) => `${await inner.render(value, ctx)} (git)`,
					})),
				],
			}),
		);
		const reports: unknown[] = [];
		const shown = new Map([
			["failing", "<failing>\nold\n</failing>"],
			["cwd", "stale"],
		]);
		const agent = resolveAgent(undefined, registry.snapshot(), resolveSettings(undefined), (error) => {
			throw error;
		});
		const desired = await renderSections(agent.sections, input, shown, (error) => reports.push(error), context);
		expect([...desired]).toEqual([
			["preamble", "You are helpful."],
			["cwd", "<cwd>\n/repo (git)\n</cwd>"],
			["failing", "<failing>\nold\n</failing>"],
		]);
		expect(reports.map((error) => (error as Error).message)).toEqual(["render failed", "also failed"]);
	});

	it("propagates section errors after cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const cancelled = { ...context, abortSignal: controller.signal };
		const failing = section("a", () => {
			throw new Error("cancelled");
		});
		await expect(renderSections([failing], input, new Map(), () => {}, cancelled)).rejects.toThrow("cancelled");
	});

	it("replays sections in place, deletes on null, and appends re-additions", () => {
		const system = (sections: Record<string, string | null>): SystemMessage => ({
			role: "system",
			content: "",
			sections,
			timestamp: 1,
		});
		const shown = replaySections([
			system({ a: "1", b: "2", c: "3" }),
			user("x"),
			system({ b: "20", a: null }),
			system({ a: "10" }),
		]);
		expect([...shown]).toEqual([
			["b", "20"],
			["c", "3"],
			["a", "10"],
		]);
	});

	it("emits minimal value patches, removals, and additions", async () => {
		const conversation = await root();
		expect(await apply(conversation, { a: "1", b: "2", c: "3" })).toEqual([{ sections: { a: "1", b: "2", c: "3" } }]);
		expect(await apply(conversation, { a: "1", b: "20", c: "3", d: "4" })).toEqual([
			{ sections: { b: "20", d: "4" } },
		]);
		expect(await apply(conversation, { a: "1", c: "3", d: "4" })).toEqual([{ sections: { b: null } }]);
		expect(await apply(conversation, { a: "1", c: "3", d: "4" })).toEqual([]);
		expect(await apply(conversation, {})).toEqual([{ sections: { a: null, c: null, d: null } }]);
	});

	it("rewrites order-only changes and re-additions as two entries", async () => {
		const conversation = await root();
		await apply(conversation, { a: "1", b: "2" });
		expect(await apply(conversation, { b: "2", a: "1" })).toEqual([
			{ sections: { a: null, b: null } },
			{ sections: { b: "2", a: "1" } },
		]);
		const readded = await root();
		await apply(readded, { a: "1", b: "2", c: "3" });
		expect(await apply(readded, { a: "1", c: "3" })).toEqual([{ sections: { b: null } }]);
		// Patching would append `b` after `c`.
		expect(await apply(readded, { a: "1", b: "2", c: "3" })).toEqual([
			{ sections: { a: null, c: null } },
			{ sections: { a: "1", b: "2", c: "3" } },
		]);
	});

	it("rebaselines after a head marker, omitting retained deltas on both sides of it", async () => {
		const conversation = await root();
		await apply(conversation, { a: "1", b: "2" });
		await conversation.commit(
			(tx) => tx.appendEntry(conversation.id, { kind: "pi.user", model: [user("hi")] }),
			context,
		);
		await apply(conversation, { a: "1", b: "20" });
		const delta = await lastSystemId(conversation);
		// The head keeps the delta but cuts its baseline: replay alone would show only `b`.
		await marker(conversation, delta);
		expect(await apply(conversation, { a: "1", b: "20" })).toEqual([
			{ sections: { a: "1", b: "20" }, omit: [delta] },
		]);
		const baseline = await lastSystemId(conversation);
		// A system entry follows the marker now, so later changes are ordinary patches.
		expect(await apply(conversation, { a: "1", b: "21" })).toEqual([{ sections: { b: "21" } }]);
		const after = await lastSystemId(conversation);
		// A second marker keeps deltas from both sides of the first one.
		await marker(conversation, delta);
		expect(await apply(conversation, { a: "1", b: "21" })).toEqual([
			{ sections: { a: "1", b: "21" }, omit: [delta, baseline, after] },
		]);
	});

	it("writes a complete post-head baseline even when replay already matches", async () => {
		const conversation = await root();
		await apply(conversation, { a: "1" });
		const baseline = await lastSystemId(conversation);
		await marker(conversation, baseline);
		expect(await apply(conversation, { a: "1" })).toEqual([{ sections: { a: "1" }, omit: [baseline] }]);
		await marker(conversation, "self");
		expect(await apply(conversation, {})).toEqual([{ sections: {} }]);
		expect(await apply(conversation, {})).toEqual([]);
	});
});

describe("tool loadout preparation", () => {
	const declaration = (name: string, description = name): Tool => ({
		name,
		description,
		parameters: Type.Object({}),
	});

	/** Plan tools only, append the plan, check that replay offers `tools` in order, and return each message's changes. */
	async function applyTools(
		conversation: Conversation,
		tools: readonly Tool[],
		sections: Record<string, string> = {},
	): Promise<{ removed?: string[]; added?: string[]; sections?: Record<string, string | null> }[]> {
		const drafts = planSystemEntries(
			await conversation.context(context),
			new Map(Object.entries(sections)),
			tools,
			7,
		);
		await conversation.commit(async (tx) => {
			for (const draft of drafts) await tx.appendEntry(SystemEntry, conversation.id, draft);
		}, context);
		const offered = getCurrentTools((await conversation.context(context)).messages);
		expect(offered).toEqual(tools.map(toToolDeclaration));
		return drafts.map((draft) => {
			const message = draft.model![0] as SystemMessage;
			return {
				...(message.toolsRemoved === undefined ? {} : { removed: message.toolsRemoved.map((tool) => tool.name) }),
				...(message.toolsAdded === undefined ? {} : { added: message.toolsAdded.map((tool) => tool.name) }),
				...(message.sections === undefined ? {} : { sections: message.sections }),
			};
		});
	}

	it("adds, removes, replaces changed declarations, and rewrites the order when needed", async () => {
		const conversation = await root();
		const [a, b, c] = [declaration("a"), declaration("b"), declaration("c")];
		expect(await applyTools(conversation, [a, b])).toEqual([{ added: ["a", "b"] }]);
		expect(await applyTools(conversation, [a, b])).toEqual([]);
		expect(await applyTools(conversation, [a, b, c])).toEqual([{ added: ["c"] }]);
		expect(await applyTools(conversation, [a, c])).toEqual([{ removed: ["b"] }]);
		// A changed declaration at the end is removed and re-added in place.
		const c2 = declaration("c", "changed");
		expect(await applyTools(conversation, [a, c2])).toEqual([{ removed: ["c"], added: ["c"] }]);
		// A changed declaration in the middle would move to the end, so the whole order is rewritten.
		const a2 = declaration("a", "changed");
		expect(await applyTools(conversation, [a2, c2])).toEqual([{ removed: ["a", "c"], added: ["a", "c"] }]);
		// Order-only change.
		expect(await applyTools(conversation, [c2, a2])).toEqual([{ removed: ["a", "c"], added: ["c", "a"] }]);
		expect(await applyTools(conversation, [])).toEqual([{ removed: ["c", "a"] }]);
	});

	it("puts tool changes on the last section entry and re-declares every tool after a head cut", async () => {
		const conversation = await root();
		const [a, b] = [declaration("a"), declaration("b")];
		expect(await applyTools(conversation, [a], { x: "1", y: "2" })).toEqual([
			{ added: ["a"], sections: { x: "1", y: "2" } },
		]);
		// Section order changes need two entries; the tool change rides on the second.
		expect(await applyTools(conversation, [a, b], { y: "2", x: "1" })).toEqual([
			{ sections: { x: null, y: null } },
			{ added: ["b"], sections: { y: "2", x: "1" } },
		]);
		await marker(conversation, "self");
		expect(await applyTools(conversation, [a, b], { y: "2", x: "1" })).toEqual([
			{ added: ["a", "b"], sections: { y: "2", x: "1" } },
		]);
	});
});
