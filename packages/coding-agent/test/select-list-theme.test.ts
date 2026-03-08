import { describe, expect, it } from "vitest";
import { getSelectListTheme, setTheme } from "../src/theme/theme.js";

describe("getSelectListTheme", () => {
	it("renders selected rows with stronger styling than plain accent text", () => {
		setTheme("dark");
		const theme = getSelectListTheme();

		const selected = theme.selectedText("→ dark");
		const description = theme.description("(current)");

		expect(selected).not.toBe("→ dark");
		expect(selected).not.toBe(theme.selectedPrefix("→ dark"));
		expect(selected).toContain("\u001b[");
		expect(description).toContain("\u001b[");
	});
});
