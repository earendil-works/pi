import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { visibleWidth } from "../src/utils.ts";

const osc8Open = (url: string) => `\x1b]8;;${url}\x1b\\`;
const osc8Close = "\x1b]8;;\x1b\\";

function visibleText(line: string): string {
	return line
		.replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.trimEnd();
}

describe("Text URL autolinking", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("wraps long plain URLs with one OSC 8 target across rendered rows", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const url =
			"https://mcp.sentry.dev/oauth/authorize?response_type=code&client_id=abc123&code_challenge=xyz&redirect_uri=http%3A%2F%2Flocalhost%3A32855%2Fcallback";

		const lines = new Text(url, 0, 0).render(40);

		assert.ok(lines.length > 1);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40);
			assert.ok(line.includes(osc8Open(url)), `line is missing OSC 8 URL open: ${JSON.stringify(line)}`);
		}
		for (const line of lines.slice(0, -1)) {
			assert.ok(line.includes(osc8Close), `non-final wrapped line is missing OSC 8 close: ${JSON.stringify(line)}`);
		}
		assert.strictEqual(lines.map(visibleText).join(""), url);
	});

	it("does not emit OSC 8 hyperlinks when terminal capabilities disable them", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const url = "https://example.com/oauth/authorize?client_id=abc123";

		const lines = new Text(url, 0, 0).render(20);

		assert.ok(lines.length > 1);
		assert.strictEqual(lines.join("\n").includes("\x1b]8;"), false);
		assert.strictEqual(lines.map((line) => line.trimEnd()).join(""), url);
	});

	it("does not double-wrap text that already contains OSC 8 hyperlinks", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const url = "https://example.com/already-linked";
		const input = `${osc8Open(url)}${url}${osc8Close}`;

		const lines = new Text(input, 0, 0).render(80);
		const openCount = (lines.join("\n").match(/\x1b\]8;;https:\/\/example\.com\/already-linked\x1b\\/g) ?? []).length;

		assert.strictEqual(openCount, 1);
	});
});
