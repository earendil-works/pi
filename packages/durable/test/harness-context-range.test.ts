import { describe, expect, it } from "vitest";
import { advanceRange, readContext, readContextFrom } from "../src/harness/context.ts";
import { SessionImpl } from "../src/session/session.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { context } from "./session-support.ts";

describe("kept context ranges", () => {
	it("is not advanced when an entry was committed while its scan ran off the line", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		class PausedStorage extends MemoryStorage {
			pause = false;
			override async scanEntries(...args: Parameters<MemoryStorage["scanEntries"]>) {
				const page = await super.scanEntries(...args);
				if (this.pause) {
					this.pause = false;
					entered.resolve();
					await release.promise;
				}
				return page;
			}
		}
		const storage = new PausedStorage();
		const session = new SessionImpl(storage);
		const conversation = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "first" }), context);
		storage.pause = true;
		const read = readContextFrom(session, storage, conversation.id, context, undefined, undefined);
		await entered.promise;
		await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "missed" }), context);
		release.resolve();
		const { range } = await read;
		expect(range?.current).toBe(false);
		const last = await session.commit((tx) => tx.appendEntry(conversation.id, { kind: "last" }), context);
		// Not current: left as it is, so the next read extends it from Storage instead of skipping "missed".
		expect(advanceRange(range!, [last])).toBe(range);
		const again = await readContextFrom(session, storage, conversation.id, context, undefined, range);
		const fresh = await readContext(session, storage, conversation.id, context);
		expect(again.view.entries.map((entry) => entry.kind)).toEqual(["first", "missed", "last"]);
		expect(again.view).toEqual(fresh);
		expect(again.range?.current).toBe(true);
		await session.close(context);
	});
});
