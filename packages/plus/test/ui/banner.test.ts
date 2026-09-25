/**
 * Tests for plus/src/coding-agent/ui/banner.ts — the Pi+ welcome banner tiers,
 * path truncation, extension naming, and the render cache.
 */

import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { VERSION } from "../../../coding-agent/src/config.ts";
import type { Theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { BannerInfo } from "../../src/coding-agent/ui/banner.ts";
import { BannerComponent, extensionDisplayName, PLUS_VERSION, truncatePath } from "../../src/coding-agent/ui/banner.ts";

/** Identity-passing theme: render output stays plain text for easy assertions. */
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
} as unknown as Theme;

function info(overrides: Partial<BannerInfo> = {}): BannerInfo {
	return {
		model: () => "test-model",
		cwd: "~/dev/project",
		resumed: undefined,
		title: () => undefined,
		...overrides,
	};
}

function plainLines(component: BannerComponent, width: number): string[] {
	return component.render(width, fakeTheme).map((l) => stripTerminalSequences(l));
}

describe("condensed tier (default startup)", () => {
	it("renders all six Pi+ logo rows plus the identity column", () => {
		const lines = plainLines(new BannerComponent(info()), 80);
		const logoRows = lines.filter((l) => l.includes("█"));
		assert.equal(logoRows.length, 6);
		assert.ok(logoRows[0]!.includes("██████"), "P top bar present");
		// Small + (3x3) at the mark's upper right: crossbar on row 1 only;
		// the I's serifs cap the first and last rows.
		assert.ok(logoRows[1]!.includes("███"), "+ crossbar on row 1");
		assert.ok(!logoRows[4]!.includes("███"), "no + on the lower rows");
		assert.ok(logoRows[5]!.includes("█████"), "I base on the last row");
		assert.ok(lines.some((l) => l.includes(`pi+ agent v${PLUS_VERSION}`)));
		assert.ok(lines.some((l) => l.includes("test-model")));
		assert.ok(lines.some((l) => l.includes("~/dev/project")));
	});

	it("brands the pi-plus release train, not pi's", () => {
		assert.match(PLUS_VERSION, /^\d+\.\d+\.\d+$/);
		assert.notEqual(PLUS_VERSION, VERSION);
	});

	it("includes the resumed identity line only when resuming", () => {
		const fresh = plainLines(new BannerComponent(info()), 80);
		assert.ok(!fresh.some((l) => l.includes("resumed")));

		const resumed = plainLines(new BannerComponent(info({ resumed: "85d19568", title: () => "my session" })), 80);
		assert.ok(resumed.some((l) => l.includes("resumed 85d19568 · my session")));
	});

	it("never overflows the viewport width", () => {
		for (const width of [40, 60, 80, 120]) {
			for (const line of plainLines(new BannerComponent(info({ resumed: "85d19568" })), width)) {
				assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${JSON.stringify(line)}`);
			}
		}
	});

	it("degrades to the borderless plain stack when too narrow for logo + column", () => {
		const lines = plainLines(new BannerComponent(info()), 20);
		assert.ok(!lines.some((l) => l.includes("█")), "no block logo at 20 cols");
		assert.ok(lines.some((l) => l.includes("pi+ agent")));
	});
});

describe("wide tier (full banner, >=76 cols)", () => {
	it("renders the two-column box with the wordmark in the top border", () => {
		const lines = plainLines(
			new BannerComponent(info({ full: true, extensions: ["ext-a"], skills: ["skill-x"] })),
			100,
		);
		assert.ok(lines[0]!.startsWith("╭─── pi+ agent"), "titled top border");
		assert.ok(
			lines.some((l) => l.startsWith("╰")),
			"bottom border",
		);
		assert.ok(lines.some((l) => l.includes("Welcome back!")));
		assert.ok(
			lines.some((l) => l.includes("test-model")),
			"identity stack present",
		);
		assert.ok(
			lines.some((l) => l.includes("Extensions")),
			"feeds in right panel",
		);
		assert.ok(lines.some((l) => l.includes("ext-a")));
		assert.ok(lines.some((l) => l.includes("Skills")));
		assert.ok(lines.some((l) => l.includes("skill-x")));
		// A vertical divider separates the two panels on content rows.
		assert.ok(
			lines.some((l) => (l.match(/│/g) ?? []).length === 3),
			"divider present",
		);
		// The Pi+ mark renders whole (all rows share one left edge).
		const logoRows = lines.filter((l) => l.includes("█"));
		assert.equal(logoRows.length, 6);
		const firstBlockCol = (l: string): number => l.indexOf("█");
		assert.ok(
			logoRows.every((l) => firstBlockCol(l) === firstBlockCol(logoRows[0]!)),
			"mark left edge aligned",
		);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 100, `overflow: ${JSON.stringify(line)}`);
		}
	});

	it("falls back to the boxed tier when the right panel would be too narrow", () => {
		// A long model name pins leftWidth at the 50 cap → rightWidth = 76-50-7 < 20.
		const lines = plainLines(new BannerComponent(info({ full: true, model: () => "m".repeat(60) })), 76);
		assert.ok(!lines[0]!.includes("pi+ agent"), "no wide wordmark border");
		assert.ok(lines[0]!.startsWith("╭"), "boxed border instead");
	});
});

describe("boxed tier (full banner)", () => {
	it("renders a rounded box with the Pi+ mark and identity stack", () => {
		const lines = plainLines(new BannerComponent(info({ full: true })), 60);
		assert.ok(lines[0]!.startsWith("╭"), "top border");
		assert.ok(
			lines.some((l) => l.startsWith("╰")),
			"bottom border",
		);
		assert.ok(lines.some((l) => l.includes("█") && l.includes("pi+ agent")));
		assert.ok(lines.some((l) => l.includes("Welcome back!")));
	});

	it("lists discovered extensions and skills in the trailer", () => {
		const lines = plainLines(
			new BannerComponent(info({ full: true, extensions: ["ext-a", "ext-b"], skills: ["skill-x"] })),
			60,
		);
		const text = lines.join("\n");
		assert.ok(text.includes("Extensions"));
		assert.ok(text.includes("ext-a, ext-b"));
		assert.ok(text.includes("Skills"));
		assert.ok(text.includes("skill-x"));
	});

	it("packs long name lists with a +N more tail", () => {
		const names = Array.from({ length: 40 }, (_, i) => `ext-${i}`);
		const lines = plainLines(new BannerComponent(info({ full: true, extensions: names })), 60);
		assert.ok(lines.some((l) => l.includes("+") && l.includes("more")));
	});
});

describe("compact tier (narrow terminals)", () => {
	it("renders the centered single-column box below 40 cols", () => {
		const lines = plainLines(new BannerComponent(info({ full: true })), 30);
		assert.ok(lines[0]!.startsWith("╭"));
		assert.ok(lines.some((l) => l.includes("pi+ agent")));
	});

	it("degrades to the plain stack instead of crashing below the border scaffold", () => {
		for (const width of [1, 8, 14]) {
			const lines = plainLines(new BannerComponent(info({ full: true })), width);
			assert.ok(!lines.some((l) => l.includes("╭")), `no box chrome at ${width} cols`);
		}
	});
});

describe("truncatePath", () => {
	it("returns short paths unchanged", () => {
		assert.equal(truncatePath("~/a/b", 20), "~/a/b");
	});

	it("middle-truncates to <first>/…/<last>", () => {
		assert.equal(truncatePath("/home/user/dev/project", 12), "/…/project");
		assert.equal(truncatePath("~/dev/project", 12), "~/…/project");
	});

	it("drops trailing separators so the tail is the real segment", () => {
		assert.equal(truncatePath("/home/user/dev/project/", 12), "/…/project");
	});

	it("falls back to a truncated tail when even the ellipsis form is too wide", () => {
		const out = truncatePath("/a/verylongtailsegment", 8);
		assert.ok(out.startsWith("/…/"));
		assert.ok(visibleWidth(out) <= 8);
	});
});

describe("extensionDisplayName", () => {
	it("strips the package-manager prefix", () => {
		assert.equal(extensionDisplayName("npm:pi-web-access"), "pi-web-access");
	});

	it("walks past generic path segments", () => {
		assert.equal(extensionDisplayName("/x/better-claude-code-ui/extension/index.ts"), "better-claude-code-ui");
	});

	it("keeps the last meaningful segment of bare paths", () => {
		assert.equal(extensionDisplayName("/home/u/.pi/agent/extensions/my-ext.ts"), "my-ext");
	});
});

describe("render cache", () => {
	it("returns the cached lines while inputs are unchanged", () => {
		const component = new BannerComponent(info());
		const first = component.render(80, fakeTheme);
		const second = component.render(80, fakeTheme);
		assert.equal(first, second, "same array reference while the key is stable");
	});

	it("recomputes when a dynamic getter flips", () => {
		let model = "model-a";
		const component = new BannerComponent(info({ model: () => model }));
		const first = component.render(80, fakeTheme);
		model = "model-b";
		const second = component.render(80, fakeTheme);
		assert.notEqual(first, second);
		assert.ok(second.some((l) => l.includes("model-b")));
	});

	it("invalidate() drops the cache", () => {
		const component = new BannerComponent(info());
		const first = component.render(80, fakeTheme);
		component.invalidate();
		assert.notEqual(component.render(80, fakeTheme), first);
	});
});
