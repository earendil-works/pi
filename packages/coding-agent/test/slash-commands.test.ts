import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("includes distinct quit and exit commands", () => {
		const quit = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "quit");
		const exit = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "exit");

		expect(quit).toEqual({ name: "quit", description: `Quit ${APP_NAME}` });
		expect(exit).toEqual({
			name: "exit",
			description: `Quit ${APP_NAME} and print the command to resume this session`,
		});
	});

	it("has unique command names", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
