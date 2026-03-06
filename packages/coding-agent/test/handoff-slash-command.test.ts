import { describe, expect, it } from "vitest";

import { parseHandoffSlashCommand } from "../src/handoff-slash-command.js";

describe("parseHandoffSlashCommand", () => {
	it("parses the default inject mode", () => {
		expect(parseHandoffSlashCommand("/handoff fix bug")).toEqual({ goal: "fix bug", mode: "inject" });
	});

	it("parses --inject mode", () => {
		expect(parseHandoffSlashCommand("/handoff --inject fix bug")).toEqual({ goal: "fix bug", mode: "inject" });
	});

	it("parses inject shorthand mode", () => {
		expect(parseHandoffSlashCommand("/handoff inject fix bug")).toEqual({ goal: "fix bug", mode: "inject" });
	});

	it("parses --summary mode explicitly", () => {
		expect(parseHandoffSlashCommand("/handoff --summary fix bug")).toEqual({ goal: "fix bug", mode: "summary" });
	});

	it("parses summary shorthand mode explicitly", () => {
		expect(parseHandoffSlashCommand("/handoff summary fix bug")).toEqual({ goal: "fix bug", mode: "summary" });
	});

	it("returns null for non-handoff input or empty goals", () => {
		expect(parseHandoffSlashCommand("/model")).toBeNull();
		expect(parseHandoffSlashCommand("/handoff")).toBeNull();
		expect(parseHandoffSlashCommand("/handoff   ")).toBeNull();
	});
});
