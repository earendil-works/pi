import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	type EntryRecord,
	GenerationTask,
	hook,
	MemoryStorage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { completed } from "./task-support.ts";

describe("entry reads for hooks and tasks", () => {
	// #11141
	it("reads raw history and single entries from a hook", async () => {
		const setup = chatSetup();
		const seen: { kinds: string[]; user?: string }[] = [];
		setup.registry.install(
			defineExtension({
				name: "reader",
				hooks: [
					hook(GenerationTask, {
						onYield: async (_answer, api, ctx) => {
							const page = await api.entries({ order: "ascending" }, 10, undefined, ctx);
							const first = page.items[0]!;
							const user = await api.entry(UserEntry, first.id, ctx);
							seen.push({
								kinds: page.items.map((entry) => entry.kind),
								...(user === undefined ? {} : { user: user.kind }),
							});
							// Another kind: undefined.
							expect(await api.entry(GenerationTask as never, first.id, ctx)).toBeUndefined();
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		// The answer is not committed yet when `onYield` asks.
		expect(seen).toEqual([{ kinds: ["pi.user"], user: "pi.user" }]);
		await harness.close(context);
	});

	// #11141
	it("pages a task's conversation history by entry ID range", async () => {
		const setup = chatSetup();
		const pages: (readonly EntryRecord[])[] = [];
		const Reader = defineTask<null, { phase: "run" }, null>({
			name: "test.reader",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, ctx) => {
					const all = await runtime.entries({ order: "ascending" }, 1, undefined, ctx);
					pages.push(all.items);
					const rest = await runtime.entries({ order: "ascending" }, 1, all.next, ctx);
					pages.push(rest.items);
					const bounded = await runtime.entries(
						{ minEntryId: rest.items[0]!.id, maxEntryId: rest.items[0]!.id },
						10,
						undefined,
						ctx,
					);
					pages.push(bounded.items);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		setup.registry.install(defineExtension({ name: "reader", tasks: [Reader] }));
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const id = await root.commit(
			(tx) => tx.createTask(Reader, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await harness.waitForTask(id, context);
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(pages.map((page) => page.map((entry) => entry.id))).toEqual([
			[entries[0]!.id],
			[entries[1]!.id],
			[entries[1]!.id],
		]);
		await harness.close(context);
	});
});
