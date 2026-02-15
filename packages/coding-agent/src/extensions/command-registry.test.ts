import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./command-registry.js";

describe("CommandRegistry", () => {
	it("selects the highest priority registration (then last write wins)", () => {
		const reg = new CommandRegistry();

		reg.registerCommand(
			{
				name: "hello",
				description: "base",
				execute: () => {},
			},
			{ sourceId: "built-in", priority: 100 },
		);

		reg.registerCommand(
			{
				name: "hello",
				description: "ext",
				execute: () => {},
			},
			{ sourceId: "ext", priority: 0 },
		);

		expect(reg.getCommand("hello")?.description).toBe("base");

		reg.registerCommand(
			{
				name: "hello",
				description: "ext2",
				execute: () => {},
			},
			{ sourceId: "ext", priority: 200 },
		);

		expect(reg.getCommand("hello")?.description).toBe("ext2");
	});

	it("unregisterBySourceId removes commands and reveals previous registrations", () => {
		const reg = new CommandRegistry();

		reg.registerCommand(
			{
				name: "hello",
				description: "base",
				execute: () => {},
			},
			{ sourceId: "built-in", priority: 0 },
		);

		reg.registerCommand(
			{
				name: "hello",
				description: "ext",
				execute: () => {},
			},
			{ sourceId: "ext", priority: 0 },
		);

		expect(reg.getCommand("hello")?.description).toBe("ext");

		reg.unregisterBySourceId("ext");
		expect(reg.getCommand("hello")?.description).toBe("base");
	});
});
