import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentHarness, HarnessClosed, HarnessNotImplemented } from "../../src/harness/agent-harness.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

describe("AgentHarness v2 scaffold", () => {
	it("opens the main lane over a v4 session", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }));
		const { harness, suspended } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});

		expect(suspended).toEqual([]);
		expect(harness.name).toBe("main");
		expect(await harness.getLeafId()).toBeNull();
		expect(await harness.lanes()).toEqual([{ name: "main", leafId: null, operation: null }]);
	});

	it("rejects unimplemented operations explicitly", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }));
		const { harness } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});

		await expect(harness.prompt("hello")).rejects.toBeInstanceOf(HarnessNotImplemented);
		await harness.close();
		await expect(harness.prompt("hello")).rejects.toBeInstanceOf(HarnessClosed);
	});
});
