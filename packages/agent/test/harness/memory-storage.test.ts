import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;

describe("MemoryStorage", () => {
	it("uses the injected clock once per transaction", async () => {
		let timestamp = NOW;
		const storage = new MemoryStorage({ now: () => timestamp++ });

		const first = await storage.commit(
			[
				sessionWrites.insertEntry({
					id: "first",
					parentId: null,
					type: "custom",
					customType: "note",
				}),
				storedValues.setValue(storedValues.sessionName, "first"),
			],
			BACKGROUND_CONTEXT,
		);
		const second = await storage.commit(
			[storedValues.setValue(storedValues.sessionName, "second")],
			BACKGROUND_CONTEXT,
		);

		expect(first.timestamp).toBe(NOW);
		expect(second.timestamp).toBe(NOW + 1);
		expect((await storage.getEntries(["first"], BACKGROUND_CONTEXT)).get("first")?.timestamp).toBe(first.timestamp);
		await storage.close(BACKGROUND_CONTEXT);
	});
});
