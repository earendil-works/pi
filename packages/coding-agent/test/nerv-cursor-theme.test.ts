import { getCursorAccentBgAnsi, getCursorAccentFgAnsi, renderCursorCell } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";

describe("nerv cursor theme", () => {
	it("drives the block cursor from the active NERV theme colors", () => {
		process.env.COLORTERM = "truecolor";
		initTheme("nerv");

		expect(getCursorAccentBgAnsi()).toBe("\u001b[48;2;217;146;74m");
		expect(getCursorAccentFgAnsi()).toBe("\u001b[38;2;17;17;19m");
		expect(renderCursorCell(" ", "accentBlock")).toContain("\u001b[48;2;217;146;74m");
	});
});
